// Server-only. The payroll app performs the whole Thyme onboarding for the user's own Safe over the
// Thyme HTTP API: prepare a Roles profile (EURC.transfer only), hand the owner one transaction, confirm
// it, create the pay-invoice executable and its run-only webhook. The app never holds a private key;
// the management key stays on this server and only ids (plus the webhook URL as a credential) land in
// the settings table.
import { type Address, getAddress, type Hex, isAddress } from 'viem'
import { appendAudit, settings } from '../store/repos'
import { EURC_TRANSFER_RULE, executableBlockReason, getThymeClient, isThymeApiError, PAYROLL_CRON_TRIGGER, payrollExecutableArgs, ThymeApiError } from '../thyme/client'
import { canOnboardThyme, getThymeEnv, getThymeTriggerMode, type ThymeEnv } from '../thyme/env'
import { SEPOLIA_CHAIN_ID } from '../thyme/eurc'
import { THYME_OWNED_SETTINGS_KEYS, THYME_SETTINGS_KEYS as K, type ThymeExecutable } from '../thyme/types'
import type { ConfirmSetupResult, ExecutableResult, OnboardingStep, PrepareProfileResult, ProfileStatusResult, ThymeErrorRecord, ThymeExecutableState, ThymeOnboardingView, ThymeProfileState } from './dto'

if (typeof window !== 'undefined') {
  throw new Error('src/lib/server/thymeOnboarding.ts is server-only')
}

/** What the Roles scope lets Thyme do on the Safe, and what it cannot. Shown before the owner signs. */
export const THYME_SCOPE = {
  can: ['Call EURC.transfer(address,uint256) from this Safe', 'Only when the payroll agent hands Thyme an approved payout', 'Gas sponsored by Thyme (Lift); the Safe needs no ETH'],
  cant: ['approve() or any other EURC function', 'Any other token or contract', 'Change owners, modules or the Safe itself', 'delegatecall or batch calls'],
} as const

export interface ThymeOnboardingState {
  safeAddress: Address | null
  ownerAddress: Address | null
  profileId: string | null
  profileAlias: string | null
  profileStatus: ThymeProfileState | null
  profileError: string | null
  rolesProxy: Address | null
  executorSafe: Address | null
  setupTxHash: Hex | null
  executableId: string | null
  executableStatus: ThymeExecutableState | null
  executablePausedReason: string | null
  /** Credential: never leaves the server. */
  webhookUrl: string | null
  lastExecutionId: string | null
  simulatedAt: string | null
  /** Last failed Thyme call, persisted so a reload still shows it under the right step. */
  lastError: ThymeErrorRecord | null
}

const addr = (v: string | null): Address | null => (v && isAddress(v) ? getAddress(v) : null)

function asProfileState(v: string | null): ThymeProfileState | null {
  return v === 'pending' || v === 'active' || v === 'failed' ? v : null
}

function asExecutableState(v: string | null): ThymeExecutableState | null {
  return v === 'provisioning' || v === 'active' || v === 'paused' || v === 'error' || v === 'deleted' ? v : null
}

function asErrorRecord(json: string | null): ThymeErrorRecord | null {
  if (!json) return null
  try {
    const v = JSON.parse(json) as Partial<ThymeErrorRecord>
    if (typeof v.message !== 'string' || typeof v.step !== 'string') return null
    return { step: v.step as OnboardingStep, message: v.message, code: v.code ?? null, requestId: v.requestId ?? null, httpStatus: v.httpStatus ?? null, at: v.at ?? new Date(0).toISOString() }
  } catch {
    return null
  }
}

export function readOnboardingState(): ThymeOnboardingState {
  const all = settings.all()
  return {
    safeAddress: addr(all[K.safeAddress] ?? null),
    ownerAddress: addr(all[K.ownerAddress] ?? null),
    profileId: all[K.profileId] ?? null,
    profileAlias: all[K.profileAlias] ?? null,
    profileStatus: asProfileState(all[K.profileStatus] ?? null),
    profileError: all[K.profileError] ?? null,
    rolesProxy: addr(all[K.rolesProxy] ?? null),
    executorSafe: addr(all[K.executorSafe] ?? null),
    setupTxHash: (all[K.setupTxHash] as Hex | undefined) ?? null,
    executableId: all[K.executableId] ?? null,
    executableStatus: asExecutableState(all[K.executableStatus] ?? null),
    executablePausedReason: all[K.executablePausedReason] ?? null,
    webhookUrl: all[K.webhookUrl] ?? null,
    lastExecutionId: all[K.lastExecutionId] ?? null,
    simulatedAt: all[K.simulatedAt] ?? null,
    lastError: asErrorRecord(all[K.lastError] ?? null),
  }
}

/** Real onboarding complete: active profile, an executable and a webhook URL to trigger it. */
export function isOnboarded(state: ThymeOnboardingState = readOnboardingState()): boolean {
  return state.profileStatus === 'active' && Boolean(state.executableId) && Boolean(state.webhookUrl)
}

/** Onboarded for real, or the owner chose the labelled simulation (no wallet, no Thyme). */
export function isReadyToPay(state: ThymeOnboardingState = readOnboardingState()): boolean {
  return isOnboarded(state) || Boolean(state.simulatedAt)
}

function missingEnv(env: ThymeEnv): string[] {
  const out: string[] = []
  if (!env.apiKey) out.push('THYME_API_KEY')
  if (!env.projectId) out.push('THYME_PROJECT_ID')
  if (!env.functionId) out.push('THYME_FUNCTION_ID')
  return out
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host
  } catch {
    return null
  }
}

export function stepOf(state: ThymeOnboardingState): OnboardingStep {
  if (isOnboarded(state)) return 'done'
  if (state.profileStatus === 'active') return 'executable'
  if (state.profileId && state.profileStatus === 'pending' && state.setupTxHash) return 'confirm'
  if (state.profileId && state.profileStatus === 'pending') return 'setup'
  if (state.safeAddress) return 'enable'
  if (state.ownerAddress) return 'safe'
  return 'connect'
}

/** Persist where the onboarding stands so a reload (or another tab) resumes at the same step. */
function commitStep(): OnboardingStep {
  const step = stepOf(readOnboardingState())
  settings.set(K.step, step)
  return step
}

export function buildOnboardingView(state: ThymeOnboardingState = readOnboardingState(), env: ThymeEnv = getThymeEnv()): ThymeOnboardingView {
  const onboarded = isOnboarded(state)
  const simulated = !onboarded && Boolean(state.simulatedAt)
  return {
    configured: canOnboardThyme(env),
    missingEnv: missingEnv(env),
    apiHost: hostOf(env.apiUrl),
    executor: env.paymentExecutor,
    appUrl: env.appUrl,
    pullTokenSet: Boolean(env.pullToken),
    triggerMode: getThymeTriggerMode(env, { executableId: state.executableId, webhookUrl: state.webhookUrl }),
    safeAddress: state.safeAddress,
    ownerAddress: state.ownerAddress,
    profileId: state.profileId,
    profileAlias: state.profileAlias,
    profileStatus: state.profileStatus,
    profileError: state.profileError,
    rolesProxy: state.rolesProxy,
    executorSafe: state.executorSafe,
    setupTxHash: state.setupTxHash,
    executableId: state.executableId,
    executableStatus: state.executableStatus,
    executablePausedReason: state.executablePausedReason,
    hasWebhook: Boolean(state.webhookUrl),
    lastExecutionId: state.lastExecutionId,
    simulatedAt: state.simulatedAt,
    lastError: state.lastError,
    onboarded,
    simulated,
    ready: onboarded || simulated,
    step: stepOf(state),
    scope: { can: [...THYME_SCOPE.can], cant: [...THYME_SCOPE.cant] },
    allowlist: [{ target: EURC_TRANSFER_RULE.target, selector: EURC_TRANSFER_RULE.selector, functionSignature: EURC_TRANSFER_RULE.functionSignature ?? 'transfer(address,uint256)' }],
  }
}

// ── Errors ────────────────────────────────────────────────────────────────

const ERROR_HINTS: Record<string, string> = {
  safe_not_eligible: 'Thyme needs a deployed Safe 1.4.1 or 1.5.0 with threshold 1 whose owner is the connected wallet.',
  chain_unavailable: 'Thyme cannot host Roles profiles on this chain right now (Roles stack or gas sponsorship missing).',
  setup_not_mined: 'The setup transaction has no receipt yet. Wait a few seconds and confirm again.',
  permissions_not_covered: 'The profile allowlist does not cover what the function declares in permissions.json.',
  not_configured: 'Set THYME_API_URL, THYME_API_KEY, THYME_PROJECT_ID and THYME_FUNCTION_ID.',
  unauthorized: 'THYME_API_KEY was refused. Use a management key or a project key of the payroll project.',
  forbidden: 'The key is not owner or admin of the workspace, or lacks the profiles:write / executables:write scopes.',
  not_found: 'Thyme does not know this id any more. Forget the onboarding and start again.',
  network_error: 'Thyme did not answer. Check THYME_API_URL and the network.',
}

/** One readable line for the UI: Thyme's message, its error code and a hint when we have one. */
export function describeThymeError(error: unknown): string {
  if (isThymeApiError(error)) {
    const parts = [error.message]
    if (error.missing?.length) parts.push(`missing: ${error.missing.map((m) => m.signature ?? `${m.target} ${m.selector}`).join(', ')}`)
    if (error.reasons?.length) parts.push(error.reasons.join('; '))
    const hint = ERROR_HINTS[error.code]
    const tail = [`code ${error.code}`, error.status ? `HTTP ${error.status}` : null, error.requestId ? `request ${error.requestId}` : null].filter(Boolean).join(', ')
    return `${parts.join(' — ')}${hint ? ` ${hint}` : ''} (${tail})`
  }
  return error instanceof Error ? error.message : String(error)
}

/** Structured form of a failed call: message, Thyme code, requestId and HTTP status when present. */
export function errorRecordOf(step: OnboardingStep, error: unknown): ThymeErrorRecord {
  return {
    step,
    message: describeThymeError(error),
    code: isThymeApiError(error) ? error.code : null,
    requestId: isThymeApiError(error) ? (error.requestId ?? null) : null,
    httpStatus: isThymeApiError(error) && error.status ? error.status : null,
    at: new Date().toISOString(),
  }
}

/** Remember the failure under its step (settings) and in the audit log; returns the readable message. */
function recordStepError(step: OnboardingStep, error: unknown): string {
  const record = errorRecordOf(step, error)
  settings.set(K.lastError, JSON.stringify(record))
  appendAudit({ actor: 'thyme', event: 'thyme.step_failed', details: { step, message: record.message, code: record.code, request_id: record.requestId, http_status: record.httpStatus } })
  commitStep()
  return record.message
}

function clearStepError(): void {
  settings.set(K.lastError, null)
}

function requireConfigured(env: ThymeEnv): asserts env is ThymeEnv & { apiKey: string; projectId: string; functionId: string } {
  const missing = missingEnv(env)
  if (missing.length > 0) throw new Error(`Thyme is not configured on this server: set ${missing.join(', ')}`)
}

function aliasFor(safe: Address): string {
  // Stable per Safe: repeating the prepare call with the same alias + Safe + owner resumes the pending row.
  return `payroll-${safe.slice(2, 10).toLowerCase()}`
}

// ── Steps ─────────────────────────────────────────────────────────────────

/** Step 2: ask Thyme for the Roles profile and the one transaction the owner sends. */
export async function prepareProfile(input: { safeAddress: string; ownerAddress: string }): Promise<PrepareProfileResult> {
  const env = getThymeEnv()
  requireConfigured(env)
  if (!isAddress(input.safeAddress)) throw new Error('Safe address is not a valid address')
  if (!isAddress(input.ownerAddress)) throw new Error('Owner address is not a valid address')
  const safeAddress = getAddress(input.safeAddress)
  const ownerAddress = getAddress(input.ownerAddress)
  if (safeAddress.toLowerCase() === ownerAddress.toLowerCase()) throw new Error('The Safe and its owner must be different accounts: connect the owner wallet and give the Safe address')

  const previous = readOnboardingState()
  if (previous.profileStatus === 'active' && previous.safeAddress && previous.safeAddress.toLowerCase() !== safeAddress.toLowerCase()) {
    throw new Error(`Payroll is already enabled on ${previous.safeAddress}. Forget that onboarding first to switch Safes.`)
  }

  const alias = aliasFor(safeAddress)
  const client = getThymeClient(env)
  let prepared: Awaited<ReturnType<typeof client.preparePayrollProfile>>
  try {
    prepared = await client.preparePayrollProfile({ projectId: env.projectId, alias, safeAddress, ownerAddress })
  } catch (error) {
    settings.set(K.safeAddress, safeAddress)
    settings.set(K.ownerAddress, ownerAddress)
    throw new Error(recordStepError('enable', error))
  }

  // Resuming the same pending profile keeps the hash of a transaction the owner already sent.
  const sameProfile = previous.profileId === prepared.profile.profileId
  clearStepError()
  settings.set(K.safeAddress, safeAddress)
  settings.set(K.ownerAddress, ownerAddress)
  settings.set(K.profileId, prepared.profile.profileId)
  settings.set(K.profileAlias, prepared.profile.alias)
  settings.set(K.profileStatus, 'pending')
  settings.set(K.profileError, null)
  settings.set(K.rolesProxy, prepared.predicted.rolesProxy)
  settings.set(K.executorSafe, prepared.predicted.executorSafe)
  settings.set(K.roleKey, prepared.profile.roleKey)
  if (!sameProfile) settings.set(K.setupTxHash, null)
  settings.set(K.simulatedAt, null)
  commitStep()
  appendAudit({
    actor: 'thyme',
    event: 'thyme.profile_prepared',
    details: {
      profile_id: prepared.profile.profileId,
      alias: prepared.profile.alias,
      safe: safeAddress,
      owner: ownerAddress,
      roles_proxy: prepared.predicted.rolesProxy,
      executor_safe: prepared.predicted.executorSafe,
      setup_data_hash: prepared.profile.setupDataHash,
      scope: prepared.scopeRules,
    },
  })
  return {
    profileId: prepared.profile.profileId,
    alias: prepared.profile.alias,
    chainId: prepared.profile.chainId || SEPOLIA_CHAIN_ID,
    safeAddress,
    ownerAddress,
    transaction: prepared.transaction,
    predicted: prepared.predicted,
    scopeRules: prepared.scopeRules,
    setupDataHash: prepared.profile.setupDataHash,
    scope: { can: [...THYME_SCOPE.can], cant: [...THYME_SCOPE.cant] },
  }
}

/** Step 4: the owner's transaction has a receipt; Thyme verifies it on chain and activates the profile. */
export async function confirmSetup(input: { profileId: string; txHash: string }): Promise<ConfirmSetupResult> {
  const env = getThymeEnv()
  requireConfigured(env)
  if (!/^0x[0-9a-fA-F]{64}$/.test(input.txHash)) throw new Error('txHash must be a 32-byte transaction hash')
  const state = readOnboardingState()
  if (state.profileId !== input.profileId) throw new Error('This profile is not the one being onboarded')
  const txHash = input.txHash as Hex
  if (state.profileStatus === 'active') {
    return { status: 'active', message: 'Roles profile already active on the Safe', rolesProxy: state.rolesProxy, executorSafe: state.executorSafe, txHash: state.setupTxHash ?? txHash }
  }
  settings.set(K.setupTxHash, txHash)
  commitStep()
  const client = getThymeClient(env)
  try {
    const result = await client.confirmRolesSetup(input.profileId, txHash)
    settings.set(K.profileStatus, 'active')
    settings.set(K.profileError, null)
    settings.set(K.rolesProxy, result.rolesProxyAddress)
    settings.set(K.executorSafe, result.executorSafeAddress)
    settings.set(K.setupTxHash, result.txHash)
    clearStepError()
    commitStep()
    appendAudit({
      actor: 'chain',
      event: 'thyme.profile_active',
      details: { profile_id: result.profileId, tx_hash: result.txHash, roles_proxy: result.rolesProxyAddress, executor_safe: result.executorSafeAddress, lift_policy_id: result.liftPolicyId },
    })
    return { status: 'active', message: 'Roles profile active on the Safe', rolesProxy: result.rolesProxyAddress, executorSafe: result.executorSafeAddress, txHash: result.txHash }
  } catch (error) {
    if (isThymeApiError(error, 'setup_not_mined')) {
      // Not a failure: the receipt is not visible to Thyme yet. Keep the step at 'confirm' and let the owner retry.
      const message = recordStepError('confirm', error)
      return { status: 'pending', message, rolesProxy: state.rolesProxy, executorSafe: state.executorSafe, txHash }
    }
    const message = recordStepError('confirm', error)
    // A refusal (409) means this transaction will never activate the profile; anything else may be transient.
    const refused = isThymeApiError(error) && error.status === 409
    settings.set(K.profileStatus, refused ? 'failed' : (state.profileStatus ?? 'pending'))
    settings.set(K.profileError, message)
    commitStep()
    appendAudit({ actor: 'thyme', event: 'thyme.profile_setup_failed', details: { profile_id: input.profileId, tx_hash: txHash, error: message } })
    throw new Error(message)
  }
}

/**
 * The owner's wallet returned a hash: store it before the receipt exists so a reload during mining lands on the
 * confirm step with the hash at hand. Also the entry point for "I already sent it: here is the hash".
 */
export function recordSetupTx(input: { profileId: string; txHash: string }): { txHash: Hex; step: OnboardingStep } {
  if (!/^0x[0-9a-fA-F]{64}$/.test(input.txHash)) throw new Error('txHash must be a 32-byte transaction hash')
  const state = readOnboardingState()
  if (state.profileId !== input.profileId) throw new Error('This profile is not the one being onboarded')
  const txHash = input.txHash as Hex
  if (state.setupTxHash?.toLowerCase() !== txHash.toLowerCase()) {
    settings.set(K.setupTxHash, txHash)
    settings.set(K.profileError, null)
    if (state.profileStatus === 'failed') settings.set(K.profileStatus, 'pending')
    appendAudit({ actor: 'owner', event: 'thyme.setup_tx_recorded', details: { profile_id: input.profileId, tx_hash: txHash } })
  }
  return { txHash, step: commitStep() }
}

/** Poll target after /setup: re-read the profile from Thyme and cache its state. */
export async function refreshProfile(profileId: string): Promise<ProfileStatusResult> {
  const env = getThymeEnv()
  requireConfigured(env)
  const client = getThymeClient(env)
  let profile: Awaited<ReturnType<typeof client.getProfile>>
  try {
    profile = await client.getProfile(profileId)
  } catch (error) {
    throw new Error(describeThymeError(error))
  }
  const roles = profile.safeRoles
  const status: ThymeProfileState = profile.status === 'active' || roles?.setupStatus === 'active' ? 'active' : roles?.setupStatus === 'failed' ? 'failed' : 'pending'
  settings.set(K.profileStatus, status)
  settings.set(K.profileError, roles?.lastError ?? null)
  if (roles?.rolesProxyAddress) settings.set(K.rolesProxy, roles.rolesProxyAddress)
  if (roles?.executorSafeAddress) settings.set(K.executorSafe, roles.executorSafeAddress)
  if (roles?.roleKey) settings.set(K.roleKey, roles.roleKey)
  if (roles?.setupTxHash) settings.set(K.setupTxHash, roles.setupTxHash)
  commitStep()
  return {
    status,
    profileStatus: profile.status,
    lastError: roles?.lastError ?? null,
    rolesProxy: roles?.rolesProxyAddress ?? null,
    executorSafe: roles?.executorSafeAddress ?? null,
    setupTxHash: roles?.setupTxHash ?? null,
    liftPolicyId: roles?.liftPolicyId ?? null,
  }
}

function cacheExecutable(executable: ThymeExecutable): void {
  settings.set(K.executableStatus, executable.status)
  settings.set(K.executablePausedReason, executable.pausedReason ?? null)
}

function executableResult(executable: ThymeExecutable, hasWebhook: boolean, message?: string): ExecutableResult {
  const block = executableBlockReason(executable)
  return {
    executableId: executable._id,
    status: executable.status,
    pausedReason: executable.pausedReason ?? null,
    hasWebhook,
    ready: executable.status === 'active' && hasWebhook,
    message: message ?? (block ? block : hasWebhook ? 'Executable active, webhook ready' : 'Executable active'),
  }
}

/**
 * Step 5: create the pay-invoice executable on the active profile (cron every minute; the app also
 * triggers it through a webhook), then the webhook. Idempotent: call it again until `ready`.
 */
export async function ensureExecutable(): Promise<ExecutableResult> {
  const env = getThymeEnv()
  requireConfigured(env)
  const state = readOnboardingState()
  if (!state.profileId || state.profileStatus !== 'active') throw new Error('Activate the Roles profile first (send and confirm the setup transaction)')
  const client = getThymeClient(env)

  let executableId = state.executableId
  if (!executableId) {
    try {
      const created = await client.createExecutable(
        {
          projectId: env.projectId,
          functionId: env.functionId,
          profileId: state.profileId,
          name: `payroll-${(state.safeAddress ?? state.profileId).slice(2, 10).toLowerCase()}`,
          trigger: PAYROLL_CRON_TRIGGER,
          args: payrollExecutableArgs(env.appUrl, { safeAddress: state.safeAddress ?? undefined, pullToken: env.pullToken }),
          gasMode: 'sponsored',
        },
        { idempotencyKey: `payroll-executable-${state.profileId}` },
      )
      executableId = created.executableId
    } catch (error) {
      throw new Error(recordStepError('executable', error))
    }
    settings.set(K.executableId, executableId)
    settings.set(K.executableStatus, 'provisioning')
    commitStep()
    appendAudit({ actor: 'thyme', event: 'thyme.executable_created', details: { executable_id: executableId, profile_id: state.profileId, function_id: env.functionId, trigger: PAYROLL_CRON_TRIGGER } })
  }

  let executable: ThymeExecutable
  try {
    executable = await client.getExecutable(executableId)
  } catch (error) {
    if (isThymeApiError(error, 'not_found')) {
      settings.set(K.executableStatus, 'deleted')
      settings.set(K.executablePausedReason, 'Thyme no longer knows this executable id; reset step 4 to create a new one')
    }
    throw new Error(recordStepError('executable', error))
  }
  cacheExecutable(executable)
  if (executable.status === 'provisioning') return executableResult(executable, Boolean(state.webhookUrl), 'Thyme is provisioning the sandbox')

  // A fresh row left paused without a permissions problem (e.g. paused by an operator) is resumed once.
  if (executable.status === 'paused' && !/permissions_not_covered/i.test(executable.pausedReason ?? '')) {
    try {
      await client.resumeExecutable(executableId)
      executable = await client.getExecutable(executableId)
      cacheExecutable(executable)
    } catch (error) {
      return executableResult(executable, Boolean(state.webhookUrl), recordStepError('executable', error))
    }
  }
  if (executable.status !== 'active') return executableResult(executable, Boolean(state.webhookUrl))

  if (!state.webhookUrl) {
    try {
      const webhook = await client.createWebhook(executableId, 'payroll-app', { idempotencyKey: `payroll-webhook-${executableId}` })
      settings.set(K.webhookUrl, webhook.url)
      settings.set(K.webhookName, webhook.webhook?.name ?? 'payroll-app')
      appendAudit({ actor: 'thyme', event: 'thyme.webhook_created', details: { executable_id: executableId, webhook_id: webhook.webhook?._id ?? null, name: webhook.webhook?.name ?? 'payroll-app' } })
    } catch (error) {
      throw new Error(recordStepError('executable', error))
    }
    appendAudit({ actor: 'thyme', event: 'thyme.onboarded', details: { profile_id: state.profileId, executable_id: executableId, safe: state.safeAddress, roles_proxy: state.rolesProxy } })
  }
  clearStepError()
  commitStep()
  return executableResult(executable, true)
}

/** Reset step 4 only: drop the stored executable + webhook so "Create executable" starts from scratch. The profile stays. */
export function resetExecutable(): void {
  const state = readOnboardingState()
  for (const key of [K.executableId, K.executableStatus, K.executablePausedReason, K.webhookUrl, K.webhookName, K.lastExecutionId]) settings.remove(key)
  if (state.lastError?.step === 'executable') clearStepError()
  commitStep()
  appendAudit({ actor: 'owner', event: 'thyme.executable_reset', details: { executable_id: state.executableId, note: 'the executable stays at Thyme; this app no longer uses it' } })
}

/** Re-read the executable from Thyme and cache its state; throws a readable error (unlike refreshExecutable). */
export async function resyncExecutable(): Promise<ExecutableResult> {
  const env = getThymeEnv()
  const state = readOnboardingState()
  if (!state.executableId) throw new Error(state.simulatedAt ? 'Simulated onboarding: there is no Thyme executable to read' : 'No Thyme executable yet: finish the onboarding first')
  if (!env.apiKey) throw new Error('THYME_API_KEY is not set: the executable cannot be read')
  try {
    const executable = await getThymeClient(env).getExecutable(state.executableId)
    cacheExecutable(executable)
    if (state.lastError?.step === 'executable') clearStepError()
    commitStep()
    appendAudit({ actor: 'thyme', event: 'thyme.executable_resynced', details: { executable_id: state.executableId, status: executable.status, paused_reason: executable.pausedReason ?? null } })
    return executableResult(executable, Boolean(state.webhookUrl))
  } catch (error) {
    if (isThymeApiError(error, 'not_found')) {
      settings.set(K.executableStatus, 'deleted')
      settings.set(K.executablePausedReason, 'Thyme no longer knows this executable id')
    }
    throw new Error(recordStepError('executable', error))
  }
}

/** Kill switch: pause or resume the Thyme executable. No-op (applied: false) without a real onboarding. */
export async function setExecutablePaused(paused: boolean): Promise<{ applied: boolean; message: string }> {
  const env = getThymeEnv()
  const state = readOnboardingState()
  if (!state.executableId) {
    return { applied: false, message: state.simulatedAt ? 'simulated onboarding: nothing to pause at Thyme' : 'no Thyme executable to pause' }
  }
  if (!env.apiKey) return { applied: false, message: 'THYME_API_KEY is not set: the Thyme executable was left as it is' }
  const client = getThymeClient(env)
  try {
    if (paused) await client.pauseExecutable(state.executableId)
    else await client.resumeExecutable(state.executableId)
    const executable = await client.getExecutable(state.executableId)
    cacheExecutable(executable)
    appendAudit({ actor: 'thyme', event: paused ? 'thyme.executable_paused' : 'thyme.executable_resumed', details: { executable_id: state.executableId, status: executable.status } })
    return { applied: true, message: paused ? 'Thyme executable paused: cron and webhook runs refuse until resumed' : `Thyme executable ${executable.status}` }
  } catch (error) {
    const message = describeThymeError(error)
    appendAudit({ actor: 'thyme', event: 'thyme.executable_toggle_failed', details: { executable_id: state.executableId, paused, error: message } })
    return { applied: false, message }
  }
}

/** Refresh the cached executable status from Thyme (agents page). Silent on failure. */
export async function refreshExecutable(): Promise<ThymeExecutable | null> {
  const env = getThymeEnv()
  const state = readOnboardingState()
  if (!env.apiKey || !state.executableId) return null
  try {
    const executable = await getThymeClient(env).getExecutable(state.executableId)
    cacheExecutable(executable)
    return executable
  } catch {
    return null
  }
}

/** Demo path without a wallet: mark the onboarding as simulated. Payouts are then labelled simulated. */
export function simulateOnboarding(safeAddress?: string | null): void {
  const safe = safeAddress && isAddress(safeAddress) ? getAddress(safeAddress) : null
  if (safe) settings.set(K.safeAddress, safe)
  settings.set(K.simulatedAt, new Date().toISOString())
  commitStep()
  appendAudit({ actor: 'owner', event: 'thyme.onboarding_simulated', details: { safe, note: 'no wallet, no Thyme: payouts are labelled simulated' } })
}

/** Forget every Thyme id (the profile and executable stay at Thyme). Keeps the Safe address. */
export function forgetOnboarding(): void {
  const state = readOnboardingState()
  for (const key of THYME_OWNED_SETTINGS_KEYS) settings.remove(key)
  commitStep()
  appendAudit({ actor: 'owner', event: 'thyme.onboarding_forgotten', details: { profile_id: state.profileId, executable_id: state.executableId } })
}

export { ThymeApiError }
