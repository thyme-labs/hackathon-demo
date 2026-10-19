// Decode Roles v2.1.1 / Safe 1.4.1 reverts into { status, name, human } for the agent and the UI.
import { decodeErrorResult, type Hex, isHex, pad } from 'viem';
import { rolesAbi } from './abi';
import { ERR_SOLIDITY_ERROR_STRING } from './constants';

// PermissionChecker.sol (v2.1.1) enum Status
export const STATUS_NAMES = [
  'Ok',
  'DelegateCallNotAllowed',
  'TargetAddressNotAllowed',
  'FunctionNotAllowed',
  'SendNotAllowed',
  'OrViolation',
  'NorViolation',
  'ParameterNotAllowed',
  'ParameterLessThanAllowed',
  'ParameterGreaterThanAllowed',
  'ParameterNotAMatch',
  'NotEveryArrayElementPasses',
  'NoArrayElementPasses',
  'ParameterNotSubsetOfAllowed',
  'BitmaskOverflow',
  'BitmaskNotAllowed',
  'CustomConditionViolation',
  'AllowanceExceeded',
  'CallAllowanceExceeded',
  'EtherAllowanceExceeded',
] as const;
export type StatusName = (typeof STATUS_NAMES)[number];

export const Status = {
  Ok: 0,
  DelegateCallNotAllowed: 1,
  TargetAddressNotAllowed: 2,
  FunctionNotAllowed: 3,
  SendNotAllowed: 4,
  OrViolation: 5,
  NorViolation: 6,
  ParameterNotAllowed: 7,
  ParameterLessThanAllowed: 8,
  ParameterGreaterThanAllowed: 9,
  ParameterNotAMatch: 10,
  AllowanceExceeded: 17,
  CallAllowanceExceeded: 18,
  EtherAllowanceExceeded: 19,
} as const;

// Human text for the per-payee mandate: Or( Matches(to == payee_i, amount WithinAllowance key_i) ... ).
export const STATUS_HUMAN: Record<number, string> = {
  1: 'Delegatecall is not permitted by the mandate.',
  2: 'This contract is not covered by the mandate (only the EURC token is allowed).',
  3: 'This function is not covered by the mandate (only EURC.transfer is allowed).',
  4: 'Sending ETH is not permitted by the mandate.',
  5: 'No approved payee matched: the wallet is not on the approved list, or the amount exceeds that payee’s remaining monthly limit.',
  7: 'A parameter does not match the mandate.',
  8: 'Amount is below the minimum set in the mandate.',
  9: 'Amount is above the per-payment cap.',
  10: 'Calldata does not match the mandate.',
  17: 'Monthly EURC limit exceeded for this payee.',
  18: 'Payment count limit exceeded.',
  19: 'ETH budget exceeded.',
};

// Safe 1.4.1 revert codes (Error(string)) the owner can hit through execTransaction.
export const SAFE_ERROR_CODES: Record<string, string> = {
  GS000: 'Safe could not finish initialization.',
  GS010: 'Not enough gas to execute the Safe transaction.',
  GS013: 'Safe transaction failed: one of the batched calls reverted.',
  GS020: 'Signatures data too short.',
  GS021: 'Invalid contract signature location.',
  GS025: 'Hash has not been approved by the owner.',
  GS026: 'Invalid owner provided (is the connected wallet an owner of this Safe?).',
  GS030: 'Only Safe owners can call this.',
  GS031: 'Method can only be called from this contract.',
  GS101: 'Module is already enabled on this Safe.',
  GS102: 'Invalid module address.',
  GS103: 'Invalid prevModule / module pair.',
  GS104: 'Roles module is not enabled on the Safe.',
  GS200: 'Owners have already been set up.',
  GS201: 'Threshold cannot exceed owner count.',
  GS202: 'Threshold must be greater than 0.',
  GS203: 'Invalid owner address provided.',
  GS204: 'Address is already an owner.',
};

export const ROLES_ERROR_HUMAN: Record<string, string> = {
  NoMembership: 'The agent key is not (or no longer) a member of this mandate role.',
  NotAuthorized: 'The caller is not an enabled module on the Roles contract.',
  ModuleTransactionFailed:
    'The mandate allowed the call, but the token transfer itself failed (not enough EURC in the Safe?).',
  MalformedMultiEntrypoint: 'Batch payload is malformed (multiSend must be a delegatecall with value 0).',
  FunctionSignatureTooShort: 'Calldata is shorter than a function selector.',
  OwnableUnauthorizedAccount: 'Only the Safe (module owner) can change the mandate.',
  TakenAddress: 'A Roles module with this mandate id already exists on this Safe. Use a new mandate id.',
  AlreadyEnabledModule: 'This module is already enabled.',
  UnsuitableRootNode: 'Condition tree rejected: unsuitable root node.',
  NotBFS: 'Condition tree rejected: nodes are not in BFS order.',
};

export type DecodedRolesRevert = {
  /** error name: ConditionViolation, NoMembership, Error(string), Panic, unknown, ... */
  name: string;
  /** PermissionChecker.Status for ConditionViolation */
  status?: number;
  statusName?: string;
  /** bytes32 info for ConditionViolation (selector for FunctionNotAllowed, allowance key for AllowanceExceeded) */
  info?: Hex;
  infoMeaning?: string;
  /** Safe GSxxx code when the revert is Error(string) with one */
  safeCode?: string;
  /** one sentence for the UI / audit log */
  human: string;
  raw: Hex;
};

const ZERO32 = pad('0x', { size: 32 });

export type KnownKeys = { allowanceKeys?: Record<string, Hex> };

function humanForString(message: string): { human: string; safeCode?: string } {
  const code = /^GS\d{3}$/.test(message) ? message : undefined;
  if (code) return { human: SAFE_ERROR_CODES[code] ?? `Safe rejected the transaction (${code}).`, safeCode: code };
  return { human: message };
}

/**
 * @param raw   revert data (0x-prefixed) from eth_call / estimateGas / a mined receipt re-simulation
 * @param known allowance keys you scoped, so `info` can be named
 */
export function decodeRolesRevert(raw: Hex, known: KnownKeys = {}): DecodedRolesRevert {
  if (!isHex(raw) || raw.length < 10) return { name: 'unknown', human: 'Reverted without data.', raw };
  try {
    // viem also returns the built-in Error(string) / Panic(uint256) names at runtime.
    const d = decodeErrorResult({ abi: rolesAbi, data: raw }) as { errorName: string; args?: readonly unknown[] };
    if (d.errorName === 'ConditionViolation') {
      const [statusArg, info] = d.args as readonly [number | bigint, Hex];
      const status = Number(statusArg);
      const statusName: string = STATUS_NAMES[status] ?? `Unknown(${status})`;
      let infoMeaning = info === ZERO32 ? '(none)' : info;
      if (status === Status.FunctionNotAllowed) infoMeaning = `selector ${info.slice(0, 10)}`;
      if (
        status === Status.AllowanceExceeded ||
        status === Status.CallAllowanceExceeded ||
        status === Status.EtherAllowanceExceeded
      ) {
        const hit = Object.entries(known.allowanceKeys ?? {}).find(([, v]) => v.toLowerCase() === info.toLowerCase());
        infoMeaning = hit ? `allowance "${hit[0]}"` : `allowance key ${info}`;
      }
      return {
        name: 'ConditionViolation',
        status,
        statusName,
        info,
        infoMeaning,
        human: STATUS_HUMAN[status] ?? `Rejected by the mandate (${statusName}).`,
        raw,
      };
    }
    if (d.errorName === 'Error') {
      const { human, safeCode } = humanForString(String(d.args?.[0] ?? ''));
      return { name: 'Error(string)', human, safeCode, raw };
    }
    if (d.errorName === 'Panic') return { name: 'Panic', human: `Panic code ${String(d.args?.[0])}.`, raw };
    const argText = d.args && d.args.length > 0 ? `(${d.args.map(String).join(', ')})` : '';
    return { name: d.errorName, human: ROLES_ERROR_HUMAN[d.errorName] ?? `${d.errorName}${argText}`, raw };
  } catch {
    if (raw.startsWith(ERR_SOLIDITY_ERROR_STRING)) {
      try {
        const s = decodeErrorResult({
          abi: [{ type: 'error', name: 'Error', inputs: [{ type: 'string', name: 'message' }] }],
          data: raw,
        });
        const { human, safeCode } = humanForString(String(s.args?.[0] ?? ''));
        return { name: 'Error(string)', human, safeCode, raw };
      } catch {
        // fall through
      }
    }
    return { name: 'unknown', human: `Undecoded revert ${raw.slice(0, 10)}.`, raw };
  }
}

/** Pull raw revert bytes out of a viem error chain (ContractFunctionRevertedError.raw / RawContractError.data). */
export function rawRevertData(err: unknown): Hex | undefined {
  let cur: unknown = err;
  for (let i = 0; i < 12 && cur && typeof cur === 'object'; i++) {
    const c = cur as { raw?: unknown; data?: unknown; cause?: unknown };
    if (typeof c.raw === 'string' && c.raw.startsWith('0x') && c.raw.length >= 10) return c.raw as Hex;
    if (typeof c.data === 'string' && c.data.startsWith('0x') && c.data.length >= 10) return c.data as Hex;
    if (c.data && typeof c.data === 'object' && typeof (c.data as { data?: unknown }).data === 'string') {
      return (c.data as { data: Hex }).data;
    }
    cur = c.cause;
  }
  return undefined;
}

/** Decode whatever viem threw; falls back to the first line of the message. */
export function explainRevert(err: unknown, known: KnownKeys = {}): DecodedRolesRevert {
  const raw = rawRevertData(err);
  if (raw) return decodeRolesRevert(raw, known);
  const message = err instanceof Error ? (err.message.split('\n')[0] ?? 'Unknown error') : String(err);
  return { name: 'unknown', human: message, raw: '0x' };
}
