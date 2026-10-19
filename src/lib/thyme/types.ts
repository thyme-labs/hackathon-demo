import type { Address, Hex } from 'viem'

/**
 * Thyme Flow contract as the payroll app codes against it.
 *
 * Source of truth: the Thyme management API (dev deployment, 2026-10-19):
 *   POST /api/v1/profiles  kind:'safe_roles'          prepare a bring-your-own-Safe Roles profile
 *   POST /api/v1/profiles/{id}/setup                   confirm the owner's setup tx and activate
 *   GET  /api/v1/profiles/{id}                         poll target
 *   POST /api/v1/executables                           create (args is a JSON-encoded string)
 *   GET  /api/v1/executables/{id}                      provisioning -> active | paused (pausedReason)
 *   POST /api/v1/executables/{id}/{pause|resume|run|simulate|webhooks}
 *   POST <webhook url>                                 run-only credential; 200 result or 202 + resultUrl
 *   GET  /api/v1/executions/{id}, /logs, lists         status, txHash, errorMessage
 * Every management response is `{ data }` or `{ data, pagination }`; every error is
 * `{ error, code, requestId }` (`permissions_not_covered` adds `missing`).
 */

// ── Envelopes and errors ──────────────────────────────────────────────────

export interface ThymeEnvelope<T> {
  data: T
}

/** Cursor page as documented under "Pagination" in the management API. */
export interface ThymePage<T> {
  data: T[]
  pagination: { cursor: string; isDone: boolean }
}

/** Error vocabulary of the management API plus the Roles onboarding codes. */
export type ThymeErrorCode =
  | 'bad_request'
  | 'invalid_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'quota_exceeded'
  | 'insufficient_balance'
  | 'payload_too_large'
  | 'internal_error'
  | 'idempotency_conflict'
  | 'idempotency_in_progress'
  | 'permissions_not_covered'
  | 'executable_must_be_paused'
  | 'version_tag_conflict'
  // Roles profile onboarding (POST /profiles kind:'safe_roles', POST /profiles/{id}/setup)
  | 'safe_not_eligible'
  | 'chain_unavailable'
  | 'setup_not_mined'
  // Webhook invocation
  | 'arguments_schema_missing'
  | 'invalid_arguments'
  | 'executable_not_active'
  | 'webhooks_disabled'
  | 'malformed_path'
  | 'rate_limited'
  // Client-side
  | 'not_configured'
  | 'network_error'
  | 'invalid_response'
  | (string & {})

/** A permission the profile does not allow (`permissions_not_covered`). */
export interface MissingPermission {
  target: Address
  selector: Hex
  signature?: string
}

/** Wire shape of a management API error. */
export interface ThymeErrorBody {
  error: string
  code: ThymeErrorCode
  requestId?: string
  /** permissions_not_covered only */
  message?: string
  status?: string
  missing?: MissingPermission[]
  reasons?: string[]
  /** idempotency_in_progress */
  retryAfterMs?: number
  details?: unknown
}

// ── Profiles (bring-your-own-Safe Roles) ──────────────────────────────────

/** One allowed call: target contract + 4-byte selector (+ signature for display). */
export interface AllowlistRule {
  target: Address
  selector: Hex
  functionSignature?: string
}

export interface SafeExecutionPolicy {
  mode: 'allowlist'
  rules: AllowlistRule[]
}

/** Body of POST /api/v1/profiles with kind 'safe_roles'. */
export interface PrepareRolesProfileRequest {
  kind: 'safe_roles'
  projectId: string
  /** 1-80 chars; same alias + Safe + owner + chain resumes the pending row. */
  alias: string
  chainId: number
  safeAddress: Address
  /** Must be an owner of a 1/1 Safe 1.4.1 or 1.5.0; sends `transaction` from MetaMask. */
  ownerAddress: Address
  executionPolicy: SafeExecutionPolicy
}

/** A plain EOA transaction for the Safe owner to send as-is (never through a Safe app or bundler). */
export interface OwnerTransaction {
  to: Address
  /** '0x0' */
  value: Hex
  data: Hex
}

export type ProfileStatus = 'pending' | 'active' | 'paused' | 'archived' | 'deleted'
export type SafeSetupStatus = 'pending' | 'active' | 'failed'

/** 201 data of POST /api/v1/profiles (kind 'safe_roles'). */
export interface PrepareRolesProfileResponse {
  profile: {
    profileId: string
    alias: string
    chainId: number
    status: 'pending'
    setupStatus: 'pending'
    safeAddress: Address
    ownerAddress: Address
    /** Server-derived role key the setup batch scopes. */
    roleKey: Hex
    sessionKeyAddress: Address
    executorDeployed: boolean
    /** keccak256 of transaction.data; the confirm step proves the mined tx carried it. */
    setupDataHash: Hex
  }
  transaction: OwnerTransaction
  predicted: { rolesProxy: Address; executorSafe: Address }
  scopeRules: AllowlistRule[]
}

/** Body of POST /api/v1/profiles/{id}/setup. Call it after the receipt is in. */
export interface ConfirmRolesSetupRequest {
  txHash: Hex
}

/** 200 data of POST /api/v1/profiles/{id}/setup. Idempotent on the same hash. */
export interface ConfirmRolesSetupResponse {
  profileId: string
  setupStatus: 'active'
  txHash: Hex
  rolesProxyAddress: Address
  executorSafeAddress: Address
  liftIntegrationId: string
  liftPolicyId: string
}

/** A scope change handed to the owner but not confirmed; blocks runs while present. */
export interface RolesScopeUpdateView {
  operationId: string
  scopeVersion: number
  executionPolicyJson: string
  previousExecutionPolicyJson: string
  roleKey?: Hex
  safeNonce: string
  dataHash: Hex
  txHash?: Hex
  txRecordedAt?: number
  createdAt: number
}

/** `safeRoles` as GET /api/v1/profiles/{id} shows it (signer key id and signatures stripped). */
export interface SafeRolesView {
  ownerAddress: Address
  safeAddress: Address
  rolesProxyAddress: Address
  rolesSaltNonce: string
  roleKey: Hex
  executorSafeAddress: Address
  executorSaltNonce: string
  executorDeployed: boolean
  sessionKeyAddress: Address
  scopeVersion: number
  executionPolicyJson: string
  /** Parsed `executionPolicyJson`; absent when it no longer normalises. */
  executionPolicy?: SafeExecutionPolicy | { mode: 'allow_all' }
  setupStatus: SafeSetupStatus
  setupDataHash?: Hex
  setupTxHash?: Hex
  /** Absent on a bring-your-own-Safe row. */
  safeDeployedByThyme?: boolean
  supersededSetups?: { setupDataHash: Hex; executionPolicyJson: string }[]
  scopeUpdate?: RolesScopeUpdateView
  staleRoleKeys?: Hex[]
  /** Set once sponsorship is provisioned (after /setup). */
  liftIntegrationId?: string
  liftPolicyId?: string
  lastError?: string
}

/** GET /api/v1/profiles/{id} data (list rows have the same shape). */
export interface ThymeProfile {
  _id: string
  _creationTime: number
  workspaceId: string
  projectId: string
  alias: string
  /** The user's Safe for safe_roles rows. */
  address?: Address
  chainId: number
  status: ProfileStatus
  /** Absent means legacy. */
  kind?: 'legacy' | 'safe_roles'
  safeRoles?: SafeRolesView
  createdAt: number
  updatedAt: number
  [extra: string]: unknown
}

// ── Executables ───────────────────────────────────────────────────────────

export type ExecutableTrigger =
  | { type: 'cron'; cronspec: string }
  | { type: 'interval'; intervalMs: number; startAt?: number }

export type ExecutableStatus = 'provisioning' | 'active' | 'paused' | 'error' | 'deleted'
export type GasMode = 'sponsored' | 'self' | 'self-funded'
export type SandboxRuntime = 'daytona' | 'gvisor'

export interface SecretBinding {
  secretId: string
  /** Env var name inside the task; absent = the secret's own key. */
  envKey?: string
}

/** Body of POST /api/v1/executables. */
export interface CreateExecutableRequest {
  projectId: string
  functionId: string
  /** Must be an active Roles profile whose allowlist covers the function's permissions.json. */
  profileId: string
  name: string
  trigger: ExecutableTrigger
  /** JSON-encoded string of the task args, e.g. JSON.stringify({ apiUrl }). */
  args?: string
  secretBindings?: SecretBinding[]
  gasMode?: GasMode
  gasFallback?: boolean
  sponsorshipProvider?: 'pimlico' | 'alchemy'
  sandboxRuntime?: SandboxRuntime
}

/** 201 data of POST /api/v1/executables. Returned before provisioning finishes. */
export interface CreateExecutableResponse {
  executableId: string
}

/** GET /api/v1/executables/{id} data. */
export interface ThymeExecutable {
  _id: string
  _creationTime: number
  workspaceId: string
  projectId: string
  functionId: string
  profileId: string
  name: string
  status: ExecutableStatus
  sandboxId?: string
  sandboxRuntime?: SandboxRuntime
  trigger: ExecutableTrigger
  args?: string
  secretBindings?: SecretBinding[]
  gasMode?: GasMode
  gasFallback?: boolean
  sponsorshipProvider?: 'pimlico' | 'alchemy'
  /** Why it sits paused, e.g. "permissions_not_covered: ...". */
  pausedReason?: string
  pendingFunctionSwitch?: { requestId: string; targetFunctionId: string; args?: string; requestedAt: number }
  lastFunctionSwitchError?: { targetFunctionId: string; message: string; failedAt: number }
  lastTriggeredAt?: number
  pinnedAt?: number
  createdAt: number
  updatedAt: number
  functionName: string
  functionVersionTag: string | null
  profileAlias: string
  profileAddress: string | null
  profileChainId: number
  [extra: string]: unknown
}

/** POST .../run and .../simulate data. */
export interface RunExecutableResponse {
  executionId: string
}

// ── Webhooks ──────────────────────────────────────────────────────────────

export interface CreateWebhookRequest {
  name: string
}

export interface ThymeWebhook {
  _id: string
  _creationTime: number
  executableId: string
  name: string
  status: 'active' | 'revoked'
  secretHint: string
  secretVersion: number
  createdByUserId: string
  createdAt: number
  updatedAt: number
  rotatedAt?: number
  revokedAt?: number
  lastInvokedAt?: number
}

/** 201 data of POST /api/v1/executables/{id}/webhooks. `url` is shown once: a run-only credential. */
export interface CreateWebhookResponse {
  webhook: ThymeWebhook
  url: string
}

/** 202 data of POST <webhook url> (Prefer: respond-async, or the run outlived the sync wait). */
export interface WebhookAcceptedResponse {
  executionId: string
  status: ThymeExecutionStatus
  /** Poll it (embeds the webhook secret; never log it). 202 + Retry-After while running. */
  resultUrl: string
  expiresAt: number
}

/** 200 data of POST <webhook url> and of GET <resultUrl> once the run is terminal. */
export interface WebhookResultResponse {
  executionId: string
  status: ThymeExecutionStatus
  source: { type: 'webhook'; webhookId: string; name: string }
  transaction: {
    txHash: Hex | null
    userOpHash: Hex | null
    blockNumber: number | null
    gasUsed: string | null
    gasCostWei: string | null
    gasCostUsdCents: number | null
    gasMode: GasMode | null
    sponsorshipProvider: 'pimlico' | 'alchemy' | null
  } | null
  storage: {
    changed: boolean
    snapshotAvailable: boolean
    version: number | null
    sizeBytes: number | null
    value: unknown
    downloadUrl: string | null
    snapshotError: string | null
  }
  metrics: {
    acceptedAt: number
    startedAt: number | null
    completedAt: number | null
    queueMs: number | null
    sandboxMs: number | null
    totalMs: number | null
    computeCuMs: number | null
    callbackCuMs: number | null
    cuUsed: number | null
    rpcCalls: number | null
    chainId: number | null
  }
  /** Set for failed and skipped runs (code 'execution_failed' | 'execution_skipped' | ...). */
  error: { code: string; message: string } | null
  expiresAt: number
}

/** What invokeWebhook returns: the terminal result (200) or the accepted stub (202). */
export type WebhookInvokeResult =
  | { kind: 'result'; httpStatus: 200; replayed: boolean; requestId?: string; data: WebhookResultResponse }
  | { kind: 'accepted'; httpStatus: 202; replayed: boolean; requestId?: string; data: WebhookAcceptedResponse }

// ── Executions ────────────────────────────────────────────────────────────

/**
 * Execution states of Thyme Flow. `submitted_unknown` means a hash exists without a
 * resolved receipt (the transfer may still land).
 */
export type ThymeExecutionStatus =
  | 'pending'
  | 'running'
  | 'simulating'
  | 'submitted'
  | 'submitted_unknown'
  | 'confirmed'
  | 'failed'
  | 'skipped'

export const TERMINAL_EXECUTION_STATUSES: readonly ThymeExecutionStatus[] = ['confirmed', 'failed', 'skipped']

export type InvocationSource = 'cron' | 'interval' | 'manual' | 'webhook'

/** GET /api/v1/executions/{id} data; list rows add `executableName`. */
export interface ThymeExecution {
  _id: string
  _creationTime: number
  workspaceId: string
  projectId?: string
  executableId: string
  functionId?: string
  invocationSource?: InvocationSource
  invocationSourceName?: string
  simulated?: boolean
  webhookId?: string
  profileId: string
  status: ThymeExecutionStatus
  statusHistory?: { status: ThymeExecutionStatus; at: number }[]
  triggeredAt: number
  completedAt?: number
  userOpHash?: Hex
  txHash?: Hex
  blockNumber?: number
  /** Gas units as a decimal string. */
  gasUsed?: string
  gasCostWei?: string
  gasCostUsdCents?: number
  rpcCalls?: number
  gasMode?: GasMode
  sponsorshipProvider?: 'pimlico' | 'alchemy'
  chainId?: number
  durationMs?: number
  computeCuMs?: number
  callbackCuMs?: number
  cuUsed?: number
  /** Redacted, user-facing reason for failed and skipped runs. */
  errorMessage?: string
  isTestnet?: boolean
  functionName: string | null
  functionVersionTag: string | null
  executableName?: string | null
  [extra: string]: unknown
}

/** One captured ctx.logger line (GET /api/v1/executions/{id}/logs), oldest first. */
export interface ThymeExecutionLog {
  _id: string
  _creationTime: number
  executionId: string
  executableId: string
  level: 'info' | 'warn' | 'error'
  message: string
  timestamp: number
}

export interface PollResult {
  execution: ThymeExecution
  /** False when the timeout elapsed first (status may still be submitted/submitted_unknown). */
  terminal: boolean
  elapsedMs: number
}

/** Outcome of a webhook-triggered run, normalised from the 200 / 202 / polled bodies. */
export interface ThymeRunOutcome {
  executionId: string
  status: ThymeExecutionStatus
  terminal: boolean
  txHash?: Hex
  userOpHash?: Hex
  blockNumber?: number
  gasUsed?: string
  error?: string
  /** 202 flows only: poll this URL (embeds the webhook secret; never log it). */
  resultUrl?: string
  replayed: boolean
  idempotencyKey: string
  requestId?: string
  raw: unknown
}

// ── App side: what the Flow task and the app exchange ─────────────────────

/** Which rail sends the EURC. PAYMENT_EXECUTOR: 'thyme' or 'simulated' (labelled fake payouts). */
export type PaymentExecutor = 'thyme' | 'simulated'

/** One row of GET /api/thyme/pending (src/routes/api/thyme/pending.ts). Exactly these four fields. */
export interface PendingPayout {
  payoutId: string
  invoiceId: string
  /** Beneficiary wallet on file. */
  wallet: Address
  /** EURC base units (6 dp) as a decimal string, same as payouts.amount_eurc. */
  amountEurc: string
}

export interface PendingResponse {
  token: 'EURC'
  chainId: 11155111
  payouts: PendingPayout[]
}

/** Status vocabulary accepted by POST /api/webhooks/thyme; maps 1:1 onto payouts.status. */
export type ThymeCallbackStatus = 'pending' | 'submitted' | 'confirmed' | 'failed' | 'reverted'

/**
 * Body of POST /api/webhooks/thyme as the task sends it (src/routes/api/webhooks/thyme.ts).
 * `executionId` is the task's synthetic run id `flow-<seq>-<account8>`; it is the same on
 * submitted / confirmed / failed for one run, so the route can match a cron-run failure
 * through payouts.thyme_execution_id even when payoutId/invoiceId are absent.
 */
export interface ThymeCallback {
  executionId: string
  status: ThymeCallbackStatus
  payoutId?: string
  invoiceId?: string
  txHash?: Hex | null
  blockNumber?: number | null
  gasUsed?: number | null
  error?: string | null
}

/** Keys the onboarding stores in the settings table (ids are configuration, the webhook URL is a credential). */
export const THYME_SETTINGS_KEYS = {
  profileId: 'thymeProfileId',
  profileAlias: 'thymeProfileAlias',
  /** 'pending' | 'active' | 'failed' as last seen from Thyme. */
  profileStatus: 'thymeProfileStatus',
  profileError: 'thymeProfileError',
  executableId: 'thymeExecutableId',
  /** Last seen executable status (provisioning | active | paused | error) and its reason. */
  executableStatus: 'thymeExecutableStatus',
  executablePausedReason: 'thymeExecutablePausedReason',
  webhookUrl: 'thymeWebhookUrl',
  webhookName: 'thymeWebhookName',
  rolesProxy: 'thymeRolesProxy',
  executorSafe: 'thymeExecutorSafe',
  setupTxHash: 'thymeSetupTxHash',
  /** Real Thyme execution id of the last triggered run (the agents page). */
  lastExecutionId: 'thymeLastExecutionId',
  /** ISO timestamp when the owner chose the labelled simulated onboarding instead of a wallet. */
  simulatedAt: 'thymeSimulatedAt',
  safeAddress: 'safeAddress',
  ownerAddress: 'ownerAddress',
} as const

/** Settings keys the onboarding owns (everything above except the Safe and owner addresses). */
export const THYME_OWNED_SETTINGS_KEYS: readonly string[] = [
  THYME_SETTINGS_KEYS.profileId,
  THYME_SETTINGS_KEYS.profileAlias,
  THYME_SETTINGS_KEYS.profileStatus,
  THYME_SETTINGS_KEYS.profileError,
  THYME_SETTINGS_KEYS.executableId,
  THYME_SETTINGS_KEYS.executableStatus,
  THYME_SETTINGS_KEYS.executablePausedReason,
  THYME_SETTINGS_KEYS.webhookUrl,
  THYME_SETTINGS_KEYS.webhookName,
  THYME_SETTINGS_KEYS.rolesProxy,
  THYME_SETTINGS_KEYS.executorSafe,
  THYME_SETTINGS_KEYS.setupTxHash,
  THYME_SETTINGS_KEYS.lastExecutionId,
  THYME_SETTINGS_KEYS.simulatedAt,
]

/** Minimal payout input for executePayout; build it from the payouts + invoices rows. */
export interface PayoutRequest {
  payoutId: string
  invoiceId: string
  payee: Address
  /** EURC base units (6 dp), i.e. BigInt(payouts.amount_eurc). */
  amountEurcUnits: bigint
}

/** payouts.status plus `skipped` (Thyme ran and found nothing to pay). */
export type PayoutExecutionStatus = 'pending' | 'submitted' | 'confirmed' | 'failed' | 'reverted' | 'skipped'

export interface ExecutePayoutResult {
  executor: PaymentExecutor
  status: PayoutExecutionStatus
  txHash?: Hex
  blockNumber?: number
  gasUsed?: string
  explorerUrl?: string
  /** Thyme's execution id for the audit log and the agents page. */
  thymeExecutionId?: string
  idempotencyKey?: string
  /** Thyme's redacted error for failed or skipped runs. */
  error?: string
  raw?: unknown
}

export interface ExecutePayoutOptions {
  /** Run-only webhook URL of the pay-invoice executable (settings.thymeWebhookUrl). Falls back to env. */
  webhookUrl?: string
  /** Bump when deliberately re-sending the same payout (Idempotency-Key suffix). */
  attempt?: number
  /** Pass the Safe so the task can refuse when the balance is short. */
  safeAddress?: Address
  /** Override APP_URL for the task's callbacks (e.g. a tunnel in local dev). */
  appUrl?: string
  /** Shared secret the task presents back to the app (THYME_PULL_TOKEN); custom webhook args replace the saved ones. */
  pullToken?: string
  /** Ask for 202 immediately instead of letting Thyme hold the request up to ~55 s. */
  respondAsync?: boolean
  /** Poll until confirmed/failed/skipped. Default true. */
  waitForConfirmation?: boolean
  /** Polling budget. Default 120 s. */
  timeoutMs?: number
}
