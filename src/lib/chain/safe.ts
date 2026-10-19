// Safe 1.4.1 helpers: discovery (Safe transaction service, keyless) with on-chain verification,
// owner execution through execTransaction with a pre-validated signature (1/1 Safe, one wallet prompt),
// and Safe creation for users without one.
import {
  type Address,
  concatHex,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  getContractAddress,
  type Hex,
  keccak256,
  type PublicClient,
  pad,
  toHex,
  zeroAddress,
} from 'viem';
import { safeAbi, safeProxyFactoryAbi } from '../roles/abi';
import { SAFE_FALLBACK_HANDLER, SAFE_L2_SINGLETON, SAFE_PROXY_FACTORY, SAFE_SENTINEL_MODULE } from '../roles/constants';
import { type DecodedRolesRevert, explainRevert, type KnownKeys } from '../roles/errors';
import type { SafeTx } from '../roles/multisend';

export const SAFE_TX_SERVICE_URL = 'https://api.safe.global/tx-service/sep/api';

export type SafeSummary = {
  address: Address;
  owners: Address[];
  threshold: number;
  nonce: number | undefined;
  version: string | undefined;
};

export type SafeDiscovery = {
  source: 'tx-service' | 'unavailable';
  safes: SafeSummary[];
  error?: string;
};

type TxServiceSafe = {
  address: string;
  owners?: string[];
  threshold?: number;
  nonce?: number | string;
  version?: string;
};
type TxServicePage = { results?: TxServiceSafe[]; next?: string | null };

function normalizeSafe(s: TxServiceSafe): SafeSummary {
  return {
    address: getAddress(s.address),
    owners: (s.owners ?? []).map((o) => getAddress(o)),
    threshold: Number(s.threshold ?? 0),
    nonce: s.nonce === undefined ? undefined : Number(s.nonce),
    version: s.version,
  };
}

export type DiscoverOptions = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** stop after this many pages of 100 (default 3) */
  maxPages?: number;
};

/**
 * Safes an owner belongs to, from the Safe transaction service (no API key). Returns source 'unavailable'
 * on any network/API failure so the UI can fall back to a manual Safe address + getSafeInfo.
 */
export async function discoverSafes(owner: Address, opts: DiscoverOptions = {}): Promise<SafeDiscovery> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxPages = opts.maxPages ?? 3;
  const safes: SafeSummary[] = [];
  let url: string | null = `${SAFE_TX_SERVICE_URL}/v2/owners/${getAddress(owner)}/safes/`;
  try {
    for (let page = 0; url && page < maxPages; page++) {
      const res: Response = await fetchImpl(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
      });
      if (!res.ok) return { source: 'unavailable', safes: [], error: `tx-service HTTP ${res.status}` };
      const body = (await res.json()) as TxServicePage;
      for (const s of body.results ?? []) safes.push(normalizeSafe(s));
      url = body.next ?? null;
    }
    return { source: 'tx-service', safes };
  } catch (err) {
    return { source: 'unavailable', safes, error: err instanceof Error ? err.message : String(err) };
  }
}

export type SafeInfo = SafeSummary & {
  isDeployed: boolean;
  modules: Address[];
};

/** On-chain truth for a Safe address: owners, threshold, enabled modules, version. Works without the tx service. */
export async function getSafeInfo(client: PublicClient, safe: Address): Promise<SafeInfo> {
  const address = getAddress(safe);
  const code = await client.getCode({ address });
  if (!code || code === '0x') {
    return { address, owners: [], threshold: 0, nonce: undefined, version: undefined, isDeployed: false, modules: [] };
  }
  const [owners, threshold, nonce, version, modules] = await Promise.all([
    client.readContract({ address, abi: safeAbi, functionName: 'getOwners' }),
    client.readContract({ address, abi: safeAbi, functionName: 'getThreshold' }),
    client.readContract({ address, abi: safeAbi, functionName: 'nonce' }),
    client.readContract({ address, abi: safeAbi, functionName: 'VERSION' }).catch(() => undefined),
    listModules(client, address),
  ]);
  return {
    address,
    owners: owners.map((o) => getAddress(o)),
    threshold: Number(threshold),
    nonce: Number(nonce),
    version,
    isDeployed: true,
    modules,
  };
}

/** All enabled modules (walks getModulesPaginated). */
export async function listModules(client: PublicClient, safe: Address, pageSize = 50n): Promise<Address[]> {
  const out: Address[] = [];
  let start: Address = SAFE_SENTINEL_MODULE;
  for (let i = 0; i < 20; i++) {
    const [page, next] = await client.readContract({
      address: safe,
      abi: safeAbi,
      functionName: 'getModulesPaginated',
      args: [start, pageSize],
    });
    out.push(...page.map((m) => getAddress(m)));
    if (next === SAFE_SENTINEL_MODULE || next === zeroAddress || page.length === 0) break;
    start = next;
  }
  return out;
}

export async function isModuleEnabled(client: PublicClient, safe: Address, module: Address): Promise<boolean> {
  return client.readContract({ address: safe, abi: safeAbi, functionName: 'isModuleEnabled', args: [module] });
}

/** prevModule argument for Safe.disableModule (the linked list points newest -> oldest, starting at the sentinel). */
export async function findPrevModule(client: PublicClient, safe: Address, module: Address): Promise<Address> {
  const modules = await listModules(client, safe);
  const idx = modules.findIndex((m) => m.toLowerCase() === module.toLowerCase());
  if (idx < 0) throw new Error(`module ${module} is not enabled on ${safe}`);
  return idx === 0 ? SAFE_SENTINEL_MODULE : (modules[idx - 1] ?? SAFE_SENTINEL_MODULE);
}

export function isOwner(info: Pick<SafeSummary, 'owners'>, address: Address): boolean {
  const a = address.toLowerCase();
  return info.owners.some((o) => o.toLowerCase() === a);
}

/** The demo flow needs one wallet prompt: a 1/1 Safe whose owner is the connected wallet. */
export function canExecuteAlone(info: Pick<SafeSummary, 'owners' | 'threshold'>, address: Address): boolean {
  return info.threshold === 1 && isOwner(info, address);
}

/** Safe 1.4.1 "pre-validated" signature: r = owner, s = 0, v = 1. Valid only when owner == msg.sender. */
export function prevalidatedSignature(owner: Address): Hex {
  return concatHex([pad(getAddress(owner), { size: 32 }), pad('0x00', { size: 32 }), '0x01']);
}

export type ExecTransactionArgs = readonly [
  Address,
  bigint,
  Hex,
  number,
  bigint,
  bigint,
  bigint,
  Address,
  Address,
  Hex,
];

/**
 * wagmi/viem writeContract parameters for Safe.execTransaction from the 1/1 owner EOA (add chainId: SEPOLIA_CHAIN_ID
 * in wagmi to force the wallet onto Sepolia). safeTxGas = 0 and gasPrice = 0, so an inner failure reverts the whole
 * transaction (GS013): nothing half-applies.
 */
export function buildExecTransactionCall(safe: Address, owner: Address, tx: SafeTx) {
  const args: ExecTransactionArgs = [
    tx.to,
    tx.value,
    tx.data,
    tx.operation,
    0n,
    0n,
    0n,
    zeroAddress,
    zeroAddress,
    prevalidatedSignature(owner),
  ];
  return {
    address: getAddress(safe),
    abi: safeAbi,
    functionName: 'execTransaction',
    args,
  } as const;
}

export type SafeSimulation = { ok: true; gasEstimate: bigint } | { ok: false; revert: DecodedRolesRevert };

/** Dry-run the owner transaction (eth_call + estimateGas from the owner) and decode the reason when it fails. */
export async function simulateSafeTx(
  client: PublicClient,
  safe: Address,
  owner: Address,
  tx: SafeTx,
  known: KnownKeys = {},
): Promise<SafeSimulation> {
  const call = buildExecTransactionCall(safe, owner, tx);
  try {
    await client.simulateContract({ ...call, account: owner });
    const gasEstimate = await client.estimateContractGas({ ...call, account: owner });
    return { ok: true, gasEstimate };
  } catch (err) {
    return { ok: false, revert: explainRevert(err, known) };
  }
}

// ---- Safe creation (SafeProxyFactory.createProxyWithNonce) ----

export function buildSafeInitializer(owners: readonly Address[], threshold = 1n): Hex {
  if (owners.length === 0) throw new Error('at least one owner');
  if (threshold < 1n || threshold > BigInt(owners.length)) throw new Error('invalid threshold');
  return encodeFunctionData({
    abi: safeAbi,
    functionName: 'setup',
    args: [
      owners.map((o) => getAddress(o)),
      threshold,
      zeroAddress,
      '0x',
      SAFE_FALLBACK_HANDLER,
      zeroAddress,
      0n,
      zeroAddress,
    ],
  });
}

/** writeContract parameters for creating a Safe 1.4.1 (L2 singleton, CompatibilityFallbackHandler). */
export function buildCreateSafeCall(owners: readonly Address[], threshold: bigint, saltNonce: bigint) {
  return {
    address: SAFE_PROXY_FACTORY,
    abi: safeProxyFactoryAbi,
    functionName: 'createProxyWithNonce',
    args: [SAFE_L2_SINGLETON, buildSafeInitializer(owners, threshold), saltNonce] as const,
  } as const;
}

let proxyCreationCodeCache: Hex | undefined;

/** CREATE2 address createProxyWithNonce will produce (reads the factory's proxyCreationCode once). */
export async function predictSafeAddress(
  client: PublicClient,
  owners: readonly Address[],
  threshold: bigint,
  saltNonce: bigint,
): Promise<Address> {
  if (!proxyCreationCodeCache) {
    proxyCreationCodeCache = await client.readContract({
      address: SAFE_PROXY_FACTORY,
      abi: safeProxyFactoryAbi,
      functionName: 'proxyCreationCode',
    });
  }
  const initializer = buildSafeInitializer(owners, threshold);
  return getContractAddress({
    opcode: 'CREATE2',
    from: SAFE_PROXY_FACTORY,
    salt: keccak256(concatHex([keccak256(initializer), pad(toHex(saltNonce), { size: 32 })])),
    bytecode: concatHex([proxyCreationCodeCache, encodeAbiParameters([{ type: 'address' }], [SAFE_L2_SINGLETON])]),
  });
}

export async function isContract(client: PublicClient, address: Address): Promise<boolean> {
  const code = await client.getCode({ address });
  return !!code && code !== '0x';
}
