// FORK TEST ONLY (scripts/fork-test.ts). Not part of the product: the payroll app holds no private key and
// pays only through Thyme Flow. This signer drives anvil's public default accounts on a local Sepolia fork to
// prove the Zodiac Roles encoders in src/lib/roles. AGENT_PRIVATE_KEY here is an anvil key passed by the script.
// SERVER ONLY. Never import from a route component or anything that ends up in the browser bundle.
// The agent EOA (AGENT_PRIVATE_KEY, testnet only) is the Roles member that pays invoices through
// rolesProxy.execTransactionWithRole. Reverts are broadcast with explicit gas so a blocked payout lands
// on chain as a failed transaction the audience can open on Etherscan.
import {
  type Address,
  createWalletClient,
  decodeEventLog,
  type Hex,
  http,
  isHex,
  type TransactionReceipt,
  type WalletClient,
} from 'viem';
import { type PrivateKeyAccount, privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { rolesAbi } from '../../src/lib/roles/abi';
import { EURC } from '../../src/lib/roles/constants';
import { type DecodedRolesRevert, explainRevert, type KnownKeys } from '../../src/lib/roles/errors';
import { buildPayoutCall } from '../../src/lib/roles/payout';
import {
  createSepoliaPublicClient,
  explorerTxUrl,
  getPublicClient,
  resolveRpcUrl,
  type SepoliaPublicClient,
} from '../../src/lib/chain/clients';

/** Enough for a payout that reverts inside the Roles checker (~70-90k observed) and for success at ~10 payees (~300k). */
export const DEFAULT_PAYOUT_GAS_LIMIT = 400_000n;
export const RECEIPT_TIMEOUT_MS = 120_000;

export type PayoutRequest = {
  rolesProxy: Address;
  roleKey: Hex;
  payee: Address;
  /** EURC base units (6 decimals) */
  amountEurc: bigint;
  /** default EURC */
  token?: Address;
};

export type AllowanceConsumption = { allowanceKey: Hex; consumed: bigint; newBalance: bigint };

export type PayoutPreflight = { ok: true; gasEstimate: bigint } | { ok: false; revert: DecodedRolesRevert };

export type PayoutResult = {
  txHash: Hex;
  status: 'confirmed' | 'reverted';
  gasUsed: bigint;
  blockNumber: bigint;
  explorerUrl: string;
  from: Address;
  submittedAt: string;
  confirmedAt: string;
  /** decoded reason when status is 'reverted' (or when the preflight failed and the tx was forced anyway) */
  revert?: DecodedRolesRevert;
  /** revert.human when status is 'reverted' (plain-text mirror for callers that only read strings) */
  error?: string;
  /** ConsumeAllowance events emitted by the Roles proxy (zero-consumption entries are filtered out) */
  consumed: AllowanceConsumption[];
};

export type SendPayoutOptions = {
  /** run eth_call first to capture the revert reason (default true) */
  preflight?: boolean;
  /** broadcast even when the preflight says it will revert (default true: the "force" demo path) */
  forceOnRevert?: boolean;
  gasLimit?: bigint;
  known?: KnownKeys;
};

export type AgentSignerOptions = {
  /** overrides AGENT_PRIVATE_KEY */
  privateKey?: Hex;
  /** overrides SEPOLIA_RPC_URL; the wallet client always talks to this single URL */
  rpcUrl?: string;
  publicClient?: SepoliaPublicClient;
};

export function readAgentPrivateKey(): Hex {
  const key = process.env.AGENT_PRIVATE_KEY?.trim();
  if (!key) throw new Error('AGENT_PRIVATE_KEY is not set');
  if (!isHex(key) || key.length !== 66) throw new Error('AGENT_PRIVATE_KEY must be a 0x-prefixed 32-byte hex string');
  return key;
}

/** Address only (safe to expose to the UI through a server function); undefined when no key is configured. */
export function getAgentAddress(): Address | undefined {
  try {
    return privateKeyToAccount(readAgentPrivateKey()).address;
  } catch {
    return undefined;
  }
}

function consumptionsFrom(receipt: TransactionReceipt, rolesProxy: Address): AllowanceConsumption[] {
  const out: AllowanceConsumption[] = [];
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== rolesProxy.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({
        abi: rolesAbi,
        data: log.data,
        topics: log.topics,
        eventName: 'ConsumeAllowance',
      });
      if (decoded.args.consumed > 0n) {
        out.push({
          allowanceKey: decoded.args.allowanceKey,
          consumed: decoded.args.consumed,
          newBalance: decoded.args.newBalance,
        });
      }
    } catch {
      // not a ConsumeAllowance log
    }
  }
  return out;
}

export class AgentSigner {
  readonly account: PrivateKeyAccount;
  readonly address: Address;
  readonly publicClient: SepoliaPublicClient;
  private readonly walletClient: WalletClient;

  constructor(opts: AgentSignerOptions = {}) {
    this.account = privateKeyToAccount(opts.privateKey ?? readAgentPrivateKey());
    this.address = this.account.address;
    const rpcUrl = opts.rpcUrl ?? resolveRpcUrl();
    this.publicClient =
      opts.publicClient ?? (opts.rpcUrl ? createSepoliaPublicClient({ rpcUrl, fallbacks: false }) : getPublicClient());
    this.walletClient = createWalletClient({
      account: this.account,
      chain: sepolia,
      transport: http(rpcUrl, { timeout: 30_000 }),
    });
  }

  /** eth_call + estimateGas as the agent; decodes the mandate's reason when it would revert. */
  async preflightPayout(req: PayoutRequest, known: KnownKeys = {}): Promise<PayoutPreflight> {
    const call = buildPayoutCall({
      rolesProxy: req.rolesProxy,
      roleKey: req.roleKey,
      payee: req.payee,
      amount: req.amountEurc,
      token: req.token ?? EURC,
    });
    try {
      await this.publicClient.call({ account: this.address, to: call.to, data: call.data });
      const gasEstimate = await this.publicClient.estimateGas({ account: this.address, to: call.to, data: call.data });
      return { ok: true, gasEstimate };
    } catch (err) {
      return { ok: false, revert: explainRevert(err, known) };
    }
  }

  /**
   * execTransactionWithRole(token, 0, transfer(payee, amount), Call, roleKey, shouldRevert=true), sent with an explicit
   * gas limit so viem does not estimate (and refuse) a reverting transaction. Waits for the receipt.
   */
  async sendPayout(req: PayoutRequest, opts: SendPayoutOptions = {}): Promise<PayoutResult> {
    const call = buildPayoutCall({
      rolesProxy: req.rolesProxy,
      roleKey: req.roleKey,
      payee: req.payee,
      amount: req.amountEurc,
      token: req.token ?? EURC,
    });
    let revert: DecodedRolesRevert | undefined;
    let gas = opts.gasLimit ?? DEFAULT_PAYOUT_GAS_LIMIT;
    if (opts.preflight !== false) {
      const pre = await this.preflightPayout(req, opts.known);
      if (pre.ok) {
        if (!opts.gasLimit) gas = (pre.gasEstimate * 13n) / 10n + 20_000n;
      } else {
        revert = pre.revert;
        if (opts.forceOnRevert === false) throw new PayoutRejectedError(revert);
      }
    }
    const submittedAt = new Date().toISOString();
    const txHash = await this.walletClient.sendTransaction({
      account: this.account,
      chain: sepolia,
      to: call.to,
      data: call.data,
      value: 0n,
      gas,
    });
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash, timeout: RECEIPT_TIMEOUT_MS });
    const status = receipt.status === 'success' ? 'confirmed' : 'reverted';
    if (status === 'reverted' && !revert) {
      revert = await this.explainMinedRevert(call.to, call.data, receipt.blockNumber, opts.known);
    }
    return {
      txHash,
      status,
      gasUsed: receipt.gasUsed,
      blockNumber: receipt.blockNumber,
      explorerUrl: explorerTxUrl(txHash),
      from: this.address,
      submittedAt,
      confirmedAt: new Date().toISOString(),
      revert: status === 'reverted' ? revert : undefined,
      error: status === 'reverted' ? (revert?.human ?? 'Transaction reverted on chain.') : undefined,
      consumed: status === 'confirmed' ? consumptionsFrom(receipt, req.rolesProxy) : [],
    };
  }

  waitForReceipt(hash: Hex): Promise<TransactionReceipt> {
    return this.publicClient.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS });
  }

  /** Re-run the call at the parent block of the failed tx to recover the revert data. */
  private async explainMinedRevert(
    to: Address,
    data: Hex,
    blockNumber: bigint,
    known: KnownKeys = {},
  ): Promise<DecodedRolesRevert> {
    try {
      await this.publicClient.call({
        account: this.address,
        to,
        data,
        blockNumber: blockNumber > 0n ? blockNumber - 1n : blockNumber,
      });
      return { name: 'unknown', human: 'Transaction reverted on chain (no revert data recovered).', raw: '0x' };
    } catch (err) {
      return explainRevert(err, known);
    }
  }
}

export class PayoutRejectedError extends Error {
  readonly revert: DecodedRolesRevert;
  constructor(revert: DecodedRolesRevert) {
    super(`payout rejected by the mandate: ${revert.human}`);
    this.name = 'PayoutRejectedError';
    this.revert = revert;
  }
}

let shared: AgentSigner | undefined;

/** Singleton built from env (AGENT_PRIVATE_KEY, SEPOLIA_RPC_URL). */
export function getAgentSigner(): AgentSigner {
  if (!shared) shared = new AgentSigner();
  return shared;
}

export function createAgentSigner(opts: AgentSignerOptions): AgentSigner {
  return new AgentSigner(opts);
}

/**
 * Convenience for the payment pipeline (env-configured signer):
 * sendPayout(rolesProxy, roleKey, payee, amountEurc) = execTransactionWithRole(EURC, 0, transfer(payee, amount), 0, roleKey, true).
 * amountEurc is in EURC base units (6 decimals). Resolves with the mined receipt summary; a mandate rejection resolves
 * with status 'reverted' and a decoded `revert` (it does not throw), so the UI can link the failed tx.
 */
export function sendPayout(
  rolesProxy: Address,
  roleKey: Hex,
  payee: Address,
  amountEurc: bigint,
  opts?: SendPayoutOptions,
): Promise<PayoutResult> {
  return getAgentSigner().sendPayout({ rolesProxy, roleKey, payee, amountEurc }, opts);
}

/** Dry run only (no transaction): the agent's `budget`/pre-send explanation. */
export function preflightPayout(
  rolesProxy: Address,
  roleKey: Hex,
  payee: Address,
  amountEurc: bigint,
  known?: KnownKeys,
): Promise<PayoutPreflight> {
  return getAgentSigner().preflightPayout({ rolesProxy, roleKey, payee, amountEurc }, known);
}
