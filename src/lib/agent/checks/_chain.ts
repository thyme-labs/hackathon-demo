// Shared Sepolia access for the on-chain checks (eurc_blacklist, safe_roles_health, transfer_preflight).
// Boot injects no chain reader into the agent, so these checks use the process-wide viem client, honour
// AGENT_OFFLINE and turn an RPC failure into a neutral skip: a flaky endpoint must never hold an invoice.
import { type Address, formatUnits, getAddress, type Hex, isAddress, isHex } from 'viem'
import { getPublicClient, resolveRpcUrl, type SepoliaPublicClient } from '../../chain/clients'
import { fiatTokenAbi } from '../../roles/abi'
import { EURC_DECIMALS } from '../../roles/constants'
import { rawRevertData } from '../../roles/errors'
import { THYME_SETTINGS_KEYS } from '../../thyme/types'
import type { AgentStore, CheckResult } from '../types'
import { type CheckContext, type CheckSpec, makeResult } from './context'

/** Circle FiatToken admin surface of EURC (Blacklistable, Pausable, Ownable, MasterMinter). */
export const EURC_EXT_ABI = fiatTokenAbi

/** Process-wide Sepolia client: SEPOLIA_RPC_URL first, the public endpoints as fallback. */
export const chainClient = (): SepoliaPublicClient => getPublicClient()

/** Host of the primary RPC endpoint for the `source` line (never the full URL: it may carry a key). */
export const rpcHost = (): string => {
  try {
    return new URL(resolveRpcUrl()).host
  } catch {
    return 'sepolia rpc'
  }
}

export interface RailAddresses {
  /** The company Safe that holds the EURC (settings.safeAddress). */
  safe: Address | null
  /** Zodiac Roles proxy enabled as a module on the Safe (settings.thymeRolesProxy). */
  rolesProxy: Address | null
  /** Thyme's executor Safe, the role member that calls execTransactionWithRole (settings.thymeExecutorSafe). */
  executorSafe: Address | null
  /** bytes32 role key the executor is a member of (settings.thymeRoleKey, stored at onboarding). */
  roleKey: Hex | null
  /** True when the owner chose the labelled simulated onboarding and no Roles profile is active. */
  simulated: boolean
}

const toAddress = (value: string | null): Address | null => (value && isAddress(value, { strict: false }) ? getAddress(value) : null)
const toBytes32 = (value: string | null): Hex | null => (value && isHex(value) && value.length === 66 ? value : null)

/** Rail addresses from the settings table, as the Thyme onboarding wrote them. */
export const railAddresses = (store: Pick<AgentStore, 'getSetting'>): RailAddresses => {
  const profileStatus = store.getSetting(THYME_SETTINGS_KEYS.profileStatus)
  return {
    safe: toAddress(store.getSetting(THYME_SETTINGS_KEYS.safeAddress)),
    rolesProxy: toAddress(store.getSetting(THYME_SETTINGS_KEYS.rolesProxy)),
    executorSafe: toAddress(store.getSetting(THYME_SETTINGS_KEYS.executorSafe)),
    roleKey: toBytes32(store.getSetting(THYME_SETTINGS_KEYS.roleKey)),
    simulated: Boolean(store.getSetting(THYME_SETTINGS_KEYS.simulatedAt)) && profileStatus !== 'active',
  }
}

type Spec = Omit<CheckSpec, 'run'>

/** First line of a viem / fetch error, short enough for an evidence sentence. */
export const errorMessage = (err: unknown): string => {
  const e = err as { shortMessage?: unknown; message?: unknown } | null
  const text = typeof e?.shortMessage === 'string' ? e.shortMessage : typeof e?.message === 'string' ? e.message : String(err)
  const line = text.split('\n')[0]?.trim() || 'unknown error'
  return line.length > 160 ? `${line.slice(0, 157)}…` : line
}

/** Neutral skip in offline mode (AGENT_OFFLINE=1); data.offline marks it as "could not look". */
export const offlineSkip = (spec: Spec, ctx: CheckContext, what: string): CheckResult =>
  makeResult(spec, ctx, {
    status: 'skip',
    evidence: `Offline mode (AGENT_OFFLINE=1): ${what} skipped.`,
    source: 'Sepolia RPC not contacted (offline mode)',
    data: { offline: true },
  })

/** Neutral skip when the RPC could not be reached or answered with an error (medium tier: never a warn). */
export const rpcSkip = (spec: Spec, ctx: CheckContext, err: unknown): CheckResult =>
  makeResult(spec, ctx, {
    status: 'skip',
    evidence: `Sepolia RPC unreachable (${errorMessage(err)}); nothing read.`,
    source: `Sepolia RPC ${rpcHost()} at ${ctx.now.toISOString()}`,
    data: { offline: true, rpc_error: errorMessage(err) },
  })

const REVERT_ERRORS = new Set(['ContractFunctionRevertedError', 'ExecutionRevertedError', 'RawContractError'])

const errorNames = (err: unknown): string[] => {
  const names: string[] = []
  let cur: unknown = err
  for (let i = 0; i < 12 && cur && typeof cur === 'object'; i++) {
    const c = cur as { name?: unknown; cause?: unknown }
    if (typeof c.name === 'string') names.push(c.name)
    cur = c.cause
  }
  return names
}

/**
 * 'revert' when the node executed the call and the contract reverted (there is revert data or a viem
 * revert error in the chain); 'transport' for everything else (unreachable, timeout, malformed answer).
 */
export const classifyCallError = (err: unknown): 'revert' | 'transport' => {
  if (rawRevertData(err)) return 'revert'
  return errorNames(err).some((n) => REVERT_ERRORS.has(n)) ? 'revert' : 'transport'
}

/** EURC base units as a number of whole tokens (1 EURC = 1 EUR). */
export const eurcNumber = (units: bigint): number => Number(formatUnits(units, EURC_DECIMALS))

/** EURC base units as "1,234.56" (no symbol; callers append " EURC"). */
export const fmtEurc = (units: bigint): string =>
  eurcNumber(units).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
