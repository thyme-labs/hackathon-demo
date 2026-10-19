import type { Address, Hex } from 'viem'
import { getThymeEnv, type ThymeEnv } from './env'
import { EURC_ADDRESS, SEPOLIA_CHAIN_ID } from './eurc'
import {
  type AllowlistRule,
  type ConfirmRolesSetupResponse,
  type CreateExecutableRequest,
  type CreateExecutableResponse,
  type CreateWebhookResponse,
  type MissingPermission,
  type PollResult,
  type PrepareRolesProfileRequest,
  type PrepareRolesProfileResponse,
  type RunExecutableResponse,
  type SafeExecutionPolicy,
  TERMINAL_EXECUTION_STATUSES,
  type ThymeErrorBody,
  type ThymeErrorCode,
  type ThymeExecutable,
  type ThymeExecution,
  type ThymeExecutionLog,
  type ThymeExecutionStatus,
  type ThymePage,
  type ThymeProfile,
  type ThymeRunOutcome,
  type WebhookAcceptedResponse,
  type WebhookInvokeResult,
  type WebhookResultResponse,
} from './types'

/**
 * Typed Thyme Flow client for the payroll app (server only: it holds the API key).
 *
 * Management API (`Authorization: Bearer <THYME_API_KEY>`, `{ data }` envelopes,
 * `{ error, code, requestId }` errors, optional `Idempotency-Key` replayed 24 h on success):
 *   POST /api/v1/profiles  kind:'safe_roles'   -> prepareRolesProfile   201 { profile, transaction, predicted, scopeRules }
 *   POST /api/v1/profiles/{id}/setup           -> confirmRolesSetup     200 { profileId, setupStatus:'active', ... }
 *   GET  /api/v1/profiles/{id}                 -> getProfile
 *   POST /api/v1/executables                   -> createExecutable      201 { executableId }
 *   GET  /api/v1/executables/{id}              -> getExecutable / waitForExecutable
 *   POST /api/v1/executables/{id}/{pause|resume|run|simulate|webhooks}
 *   GET  /api/v1/executions/{id}, /logs, /api/v1/executables/{id}/executions, /api/v1/executions?projectId=
 * Webhook invocation (no key; the URL is the credential): POST <url> -> 200 result | 202 + resultUrl.
 */

const DEFAULT_TIMEOUT_MS = 15_000
/** /setup re-reads the receipt and verifies the Roles stack on chain; Thyme caps its wait at 45 s. */
const SETUP_TIMEOUT_MS = 60_000
const WEBHOOK_SYNC_TIMEOUT_MS = 60_000
const WEBHOOK_ASYNC_TIMEOUT_MS = 15_000

// ── Errors ────────────────────────────────────────────────────────────────

export class ThymeApiError extends Error {
  readonly status: number
  readonly code: ThymeErrorCode
  readonly requestId?: string
  /** permissions_not_covered: calls the profile must allow before the executable can run. */
  readonly missing?: MissingPermission[]
  readonly reasons?: string[]
  readonly retryAfterMs?: number
  readonly body?: unknown

  constructor(
    message: string,
    init: {
      status: number
      code: ThymeErrorCode
      requestId?: string
      missing?: MissingPermission[]
      reasons?: string[]
      retryAfterMs?: number
      body?: unknown
    },
  ) {
    super(message)
    this.name = 'ThymeApiError'
    this.status = init.status
    this.code = init.code
    this.requestId = init.requestId
    this.missing = init.missing
    this.reasons = init.reasons
    this.retryAfterMs = init.retryAfterMs
    this.body = init.body
  }

  is(code: ThymeErrorCode): boolean {
    return this.code === code
  }

  /** Build from a non-2xx response body (management API or webhook error envelope). */
  static fromResponse(status: number, body: unknown, requestId?: string): ThymeApiError {
    const envelope = (isRecord(body) ? body : {}) as Partial<ThymeErrorBody>
    const code = typeof envelope.code === 'string' ? envelope.code : status === 401 ? 'unauthorized' : status === 404 ? 'not_found' : 'internal_error'
    const message =
      (typeof envelope.message === 'string' && envelope.message) ||
      (typeof envelope.error === 'string' && envelope.error) ||
      `Thyme request failed with HTTP ${status}`
    return new ThymeApiError(message, {
      status,
      code,
      requestId: envelope.requestId ?? requestId,
      missing: Array.isArray(envelope.missing) ? envelope.missing : undefined,
      reasons: Array.isArray(envelope.reasons) ? envelope.reasons : undefined,
      retryAfterMs: typeof envelope.retryAfterMs === 'number' ? envelope.retryAfterMs : undefined,
      body,
    })
  }
}

export function isThymeApiError(error: unknown, code?: ThymeErrorCode): error is ThymeApiError {
  return error instanceof ThymeApiError && (code === undefined || error.code === code)
}

// ── Helpers ───────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseJson(text: string): unknown {
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function combineSignals(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
      },
      { once: true },
    )
  })
}

function buildQuery(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value))
  }
  const text = search.toString()
  return text ? `?${text}` : ''
}

/** `${prefix}-<uuid>`: a fresh key means "do not replay an earlier answer". */
export function newIdempotencyKey(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`
}

export function isTerminalStatus(status: string): status is 'confirmed' | 'failed' | 'skipped' {
  return (TERMINAL_EXECUTION_STATUSES as readonly string[]).includes(status)
}

/** The only call the payroll profile allows: EURC.transfer(address,uint256) on Sepolia. */
export const EURC_TRANSFER_RULE: AllowlistRule = {
  target: EURC_ADDRESS,
  selector: '0xa9059cbb',
  functionSignature: 'transfer(address,uint256)',
}

export const PAYROLL_EXECUTION_POLICY: SafeExecutionPolicy = { mode: 'allowlist', rules: [EURC_TRANSFER_RULE] }

/** Cron every minute: the task pulls /api/thyme/pending and pays one payout per run. */
export const PAYROLL_CRON_TRIGGER = { type: 'cron', cronspec: '* * * * *' } as const

export interface PayrollTaskArgs {
  /** Pass the Safe so the task refuses when the EURC balance is short. */
  safeAddress?: Address
  /** THYME_PULL_TOKEN; the task sends it back as X-Thyme-Token. Stored on the executable, so keep it a shared secret only. */
  pullToken?: string
}

/** Saved executable `args` (a JSON-encoded string) for the pay-invoice function: cron runs pay the oldest pending payout. */
export function payrollExecutableArgs(appUrl: string, extra: PayrollTaskArgs = {}): string {
  return JSON.stringify(taskArgs(appUrl, extra))
}

function taskArgs(appUrl: string, extra: PayrollTaskArgs, invoiceId?: string): Record<string, string> {
  const args: Record<string, string> = { apiUrl: appUrl }
  if (invoiceId) args.invoiceId = invoiceId
  if (extra.pullToken) args.pullToken = extra.pullToken
  if (extra.safeAddress) args.safeAddress = extra.safeAddress
  return args
}

/** Why an executable cannot run yet, or undefined when it is active. */
export function executableBlockReason(executable: ThymeExecutable): string | undefined {
  switch (executable.status) {
    case 'active':
      return undefined
    case 'provisioning':
      return 'Thyme is still provisioning the sandbox'
    case 'paused':
      return executable.pausedReason ?? 'Executable is paused'
    case 'error':
      return executable.pausedReason ?? 'Executable is in error'
    case 'deleted':
      return 'Executable was deleted'
    default:
      return `Executable status ${executable.status}`
  }
}

// ── Client ────────────────────────────────────────────────────────────────

export interface ThymeClientConfig {
  apiUrl: string
  apiKey?: string
  workspaceId?: string
  timeoutMs?: number
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  body?: unknown
  idempotencyKey?: string
  timeoutMs?: number
  signal?: AbortSignal
}

export interface ThymeResponse<T> {
  data: T
  httpStatus: number
  requestId?: string
  /** True when Thyme replayed an earlier response for the same Idempotency-Key. */
  replayed: boolean
  raw: unknown
}

export interface PollOptions {
  intervalMs?: number
  timeoutMs?: number
  signal?: AbortSignal
  onUpdate?: (execution: ThymeExecution) => void
}

export interface WaitOptions {
  intervalMs?: number
  timeoutMs?: number
  signal?: AbortSignal
}

export interface ListExecutionsOptions {
  limit?: number
  cursor?: string
}

export interface ListProjectExecutionsOptions extends ListExecutionsOptions {
  /** submitted_unknown is not filterable. */
  status?: Exclude<ThymeExecutionStatus, 'submitted_unknown'>
}

export class ThymeClient {
  readonly config: ThymeClientConfig

  constructor(config: ThymeClientConfig) {
    this.config = { ...config, apiUrl: config.apiUrl.replace(/\/+$/, '') }
  }

  /** One management API call. Throws ThymeApiError on any non-2xx or transport failure. */
  async requestRaw<T>(path: string, options: RequestOptions = {}): Promise<ThymeResponse<T>> {
    if (!this.config.apiKey) {
      throw new ThymeApiError('THYME_API_KEY is not set', { status: 0, code: 'not_configured' })
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.apiKey}`,
      Accept: 'application/json',
    }
    if (this.config.workspaceId) headers['X-Workspace-Id'] = this.config.workspaceId
    if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey
    if (options.body !== undefined) headers['Content-Type'] = 'application/json'

    let response: Response
    try {
      response = await fetch(`${this.config.apiUrl}${path}`, {
        method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: combineSignals(options.timeoutMs ?? this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS, options.signal),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new ThymeApiError(`Thyme request failed: ${message}`, { status: 0, code: 'network_error' })
    }
    const requestId = response.headers.get('x-request-id') ?? undefined
    const json = parseJson(await response.text())
    if (!response.ok) throw ThymeApiError.fromResponse(response.status, json, requestId)
    if (!isRecord(json) || !('data' in json)) {
      throw new ThymeApiError('Thyme response has no data envelope', { status: response.status, code: 'invalid_response', requestId, body: json })
    }
    return {
      data: json.data as T,
      httpStatus: response.status,
      requestId,
      replayed: response.headers.get('idempotency-replayed') === 'true',
      raw: json,
    }
  }

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return (await this.requestRaw<T>(path, options)).data
  }

  // ── Profiles ──

  /**
   * Prepare a Roles profile for the user's own 1/1 Safe. Returns the exact `transaction` the owner
   * sends from MetaMask. Repeating with the same alias + Safe + owner + chain resumes the pending
   * row. Errors: 400 safe_not_eligible | invalid_request, 409 chain_unavailable | conflict.
   */
  prepareRolesProfile(
    request: Omit<PrepareRolesProfileRequest, 'kind'>,
    options: { idempotencyKey?: string; signal?: AbortSignal } = {},
  ): Promise<PrepareRolesProfileResponse> {
    const body: PrepareRolesProfileRequest = { kind: 'safe_roles', ...request }
    return this.request<PrepareRolesProfileResponse>('/api/v1/profiles', {
      method: 'POST',
      body,
      idempotencyKey: options.idempotencyKey,
      signal: options.signal,
      timeoutMs: SETUP_TIMEOUT_MS,
    })
  }

  /** Prepare with the payroll defaults: Sepolia, EURC.transfer only. */
  preparePayrollProfile(input: { projectId: string; alias: string; safeAddress: Address; ownerAddress: Address; idempotencyKey?: string }) {
    return this.prepareRolesProfile(
      {
        projectId: input.projectId,
        alias: input.alias,
        chainId: SEPOLIA_CHAIN_ID,
        safeAddress: input.safeAddress,
        ownerAddress: input.ownerAddress,
        executionPolicy: PAYROLL_EXECUTION_POLICY,
      },
      { idempotencyKey: input.idempotencyKey },
    )
  }

  /**
   * Confirm the owner's setup transaction once it has a receipt; Thyme verifies it on chain and
   * activates the profile. Idempotent on the same hash. 409 setup_not_mined -> call again later.
   * No Idempotency-Key by design: a refusal must not be replayed.
   */
  confirmRolesSetup(profileId: string, txHash: Hex, options: { signal?: AbortSignal } = {}): Promise<ConfirmRolesSetupResponse> {
    return this.request<ConfirmRolesSetupResponse>(`/api/v1/profiles/${encodeURIComponent(profileId)}/setup`, {
      method: 'POST',
      body: { txHash },
      signal: options.signal,
      timeoutMs: SETUP_TIMEOUT_MS,
    })
  }

  getProfile(profileId: string): Promise<ThymeProfile> {
    return this.request<ThymeProfile>(`/api/v1/profiles/${encodeURIComponent(profileId)}`)
  }

  // ── Executables ──

  /**
   * Create an executable. Returns before provisioning finishes: follow with waitForExecutable.
   * Refused with 409 permissions_not_covered (error.missing) when the profile's allowlist does
   * not cover the function's permissions.json.
   */
  createExecutable(request: CreateExecutableRequest, options: { idempotencyKey?: string } = {}): Promise<CreateExecutableResponse> {
    return this.request<CreateExecutableResponse>('/api/v1/executables', {
      method: 'POST',
      body: request,
      idempotencyKey: options.idempotencyKey,
    })
  }

  getExecutable(executableId: string): Promise<ThymeExecutable> {
    return this.request<ThymeExecutable>(`/api/v1/executables/${encodeURIComponent(executableId)}`)
  }

  /** Poll until the executable leaves `provisioning` (active, or paused with pausedReason). */
  async waitForExecutable(executableId: string, options: WaitOptions = {}): Promise<ThymeExecutable> {
    const intervalMs = options.intervalMs ?? 2_000
    const timeoutMs = options.timeoutMs ?? 120_000
    const startedAt = Date.now()
    for (;;) {
      const executable = await this.getExecutable(executableId)
      if (executable.status !== 'provisioning' || Date.now() - startedAt >= timeoutMs) return executable
      await sleep(intervalMs, options.signal)
    }
  }

  private executableAction<T>(executableId: string, action: string, body?: unknown, idempotencyKey?: string): Promise<T> {
    return this.request<T>(`/api/v1/executables/${encodeURIComponent(executableId)}/${action}`, {
      method: 'POST',
      body: body ?? {},
      idempotencyKey,
    })
  }

  pauseExecutable(executableId: string): Promise<{ success: true }> {
    return this.executableAction(executableId, 'pause')
  }

  /** Only for a row left `paused`; a covered executable activates itself after provisioning. */
  resumeExecutable(executableId: string): Promise<{ success: true }> {
    return this.executableAction(executableId, 'resume')
  }

  /** Queue a real run with the saved args (needs executables:run, owner/admin). */
  runExecutable(executableId: string, idempotencyKey: string = newIdempotencyKey('run')): Promise<RunExecutableResponse> {
    return this.executableAction(executableId, 'run', undefined, idempotencyKey)
  }

  simulateExecutable(executableId: string, idempotencyKey: string = newIdempotencyKey('simulate')): Promise<RunExecutableResponse> {
    return this.executableAction(executableId, 'simulate', undefined, idempotencyKey)
  }

  /** Create a run-only webhook. `url` is returned once: store it as a credential, never log it. */
  createWebhook(executableId: string, name: string, options: { idempotencyKey?: string } = {}): Promise<CreateWebhookResponse> {
    return this.executableAction(executableId, 'webhooks', { name }, options.idempotencyKey)
  }

  // ── Executions ──

  getExecution(executionId: string): Promise<ThymeExecution> {
    return this.request<ThymeExecution>(`/api/v1/executions/${encodeURIComponent(executionId)}`)
  }

  getExecutionLogs(executionId: string): Promise<ThymeExecutionLog[]> {
    return this.request<ThymeExecutionLog[]>(`/api/v1/executions/${encodeURIComponent(executionId)}/logs`)
  }

  /** Runs of one executable, newest first. Follow `pagination.cursor` until `isDone`. */
  async listExecutions(executableId: string, options: ListExecutionsOptions = {}): Promise<ThymePage<ThymeExecution>> {
    const query = buildQuery({ limit: options.limit, cursor: options.cursor })
    const response = await this.requestRaw<ThymeExecution[]>(`/api/v1/executables/${encodeURIComponent(executableId)}/executions${query}`)
    return pageOf(response)
  }

  async listProjectExecutions(projectId: string, options: ListProjectExecutionsOptions = {}): Promise<ThymePage<ThymeExecution>> {
    const query = buildQuery({ projectId, status: options.status, limit: options.limit, cursor: options.cursor })
    const response = await this.requestRaw<ThymeExecution[]>(`/api/v1/executions${query}`)
    return pageOf(response)
  }

  /** Poll GET /api/v1/executions/{id} until confirmed | failed | skipped, or until the budget runs out. */
  async pollUntilTerminal(executionId: string, options: PollOptions = {}): Promise<PollResult> {
    const intervalMs = options.intervalMs ?? 2_000
    const timeoutMs = options.timeoutMs ?? 120_000
    const startedAt = Date.now()
    for (;;) {
      const execution = await this.getExecution(executionId)
      options.onUpdate?.(execution)
      const elapsedMs = Date.now() - startedAt
      if (isTerminalStatus(execution.status)) return { execution, terminal: true, elapsedMs }
      if (elapsedMs >= timeoutMs) return { execution, terminal: false, elapsedMs }
      await sleep(intervalMs, options.signal)
    }
  }
}

function pageOf<T>(response: ThymeResponse<T[]>): ThymePage<T> {
  const raw = isRecord(response.raw) ? response.raw : {}
  const pagination = isRecord(raw.pagination) ? raw.pagination : {}
  return {
    data: Array.isArray(response.data) ? response.data : [],
    pagination: {
      cursor: typeof pagination.cursor === 'string' ? pagination.cursor : '',
      isDone: typeof pagination.isDone === 'boolean' ? pagination.isDone : true,
    },
  }
}

export function createThymeClient(config: ThymeClientConfig): ThymeClient {
  return new ThymeClient(config)
}

/** Client built from THYME_API_URL / THYME_API_KEY / THYME_WORKSPACE_ID. */
export function getThymeClient(current: ThymeEnv = getThymeEnv()): ThymeClient {
  return new ThymeClient({ apiUrl: current.apiUrl, apiKey: current.apiKey, workspaceId: current.workspaceId })
}

// ── Webhook invocation (no API key; the URL is the credential) ────────────

export interface InvokeWebhookOptions {
  /** Replayed for 24 h: the same key never starts a second run. */
  idempotencyKey: string
  /** Send `Prefer: respond-async` and return the 202 immediately. */
  respondAsync?: boolean
  timeoutMs?: number
  signal?: AbortSignal
}

/**
 * POST the executable's webhook URL. An empty `args` runs with the saved args; a non-empty object
 * replaces them entirely (every required schema field must be present). 200 = terminal result,
 * 202 = accepted with `resultUrl` to poll.
 */
export async function invokeWebhook(
  webhookUrl: string,
  args: Record<string, unknown> | undefined,
  options: InvokeWebhookOptions,
): Promise<WebhookInvokeResult> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'Idempotency-Key': options.idempotencyKey,
  }
  if (options.respondAsync) headers.Prefer = 'respond-async'
  const timeoutMs = options.timeoutMs ?? (options.respondAsync ? WEBHOOK_ASYNC_TIMEOUT_MS : WEBHOOK_SYNC_TIMEOUT_MS)

  let response: Response
  try {
    response = await fetch(webhookUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(args ?? {}),
      signal: combineSignals(timeoutMs, options.signal),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new ThymeApiError(`Thyme webhook call failed: ${message}`, { status: 0, code: 'network_error' })
  }
  const requestId = response.headers.get('x-request-id') ?? undefined
  const replayed = response.headers.get('idempotency-replayed') === 'true'
  const json = parseJson(await response.text())
  if (!response.ok) throw ThymeApiError.fromResponse(response.status, json, requestId)
  const data = isRecord(json) && isRecord(json.data) ? json.data : undefined
  if (!data || typeof data.executionId !== 'string') {
    throw new ThymeApiError('Thyme webhook response has no execution', { status: response.status, code: 'invalid_response', requestId, body: json })
  }
  if (response.status === 202) {
    return { kind: 'accepted', httpStatus: 202, replayed, requestId, data: data as unknown as WebhookAcceptedResponse }
  }
  return { kind: 'result', httpStatus: 200, replayed, requestId, data: data as unknown as WebhookResultResponse }
}

/**
 * Poll a webhook `resultUrl` (202 flow) without a management key: 202 + Retry-After while the
 * run is in progress, 200 with the sanitized terminal result.
 */
export async function pollWebhookResult(
  resultUrl: string,
  options: WaitOptions = {},
): Promise<{ terminal: boolean; data: WebhookResultResponse | WebhookAcceptedResponse; elapsedMs: number }> {
  const timeoutMs = options.timeoutMs ?? 120_000
  const startedAt = Date.now()
  for (;;) {
    const response = await fetch(resultUrl, {
      headers: { Accept: 'application/json' },
      signal: combineSignals(DEFAULT_TIMEOUT_MS, options.signal),
    })
    const requestId = response.headers.get('x-request-id') ?? undefined
    const json = parseJson(await response.text())
    if (!response.ok) throw ThymeApiError.fromResponse(response.status, json, requestId)
    const data = isRecord(json) && isRecord(json.data) ? json.data : {}
    if (response.status !== 202) {
      return { terminal: true, data: data as unknown as WebhookResultResponse, elapsedMs: Date.now() - startedAt }
    }
    const elapsedMs = Date.now() - startedAt
    if (elapsedMs >= timeoutMs) return { terminal: false, data: data as unknown as WebhookAcceptedResponse, elapsedMs }
    const retryAfter = Number(response.headers.get('retry-after') ?? '2')
    await sleep((Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : options.intervalMs ?? 2) * 1_000, options.signal)
  }
}

function asHex(value: unknown): Hex | undefined {
  return typeof value === 'string' && /^0x[0-9a-fA-F]+$/.test(value) ? (value as Hex) : undefined
}

/** Normalise a 200 / 202 / polled webhook body into one outcome. */
export function outcomeFromWebhook(
  data: WebhookResultResponse | WebhookAcceptedResponse,
  meta: { idempotencyKey: string; replayed: boolean; requestId?: string },
): ThymeRunOutcome {
  const full = 'transaction' in data ? data : undefined
  return {
    executionId: data.executionId,
    status: data.status,
    terminal: isTerminalStatus(data.status),
    txHash: asHex(full?.transaction?.txHash),
    userOpHash: asHex(full?.transaction?.userOpHash),
    blockNumber: full?.transaction?.blockNumber ?? undefined,
    gasUsed: full?.transaction?.gasUsed ?? undefined,
    error: full?.error?.message,
    resultUrl: 'resultUrl' in data ? data.resultUrl : undefined,
    replayed: meta.replayed,
    idempotencyKey: meta.idempotencyKey,
    requestId: meta.requestId,
    raw: data,
  }
}

/** Normalise an execution record into the same outcome shape. */
export function outcomeFromExecution(execution: ThymeExecution, meta: { idempotencyKey: string; replayed?: boolean }): ThymeRunOutcome {
  return {
    executionId: execution._id,
    status: execution.status,
    terminal: isTerminalStatus(execution.status),
    txHash: asHex(execution.txHash),
    userOpHash: asHex(execution.userOpHash),
    blockNumber: execution.blockNumber,
    gasUsed: execution.gasUsed,
    error: execution.errorMessage,
    replayed: meta.replayed ?? false,
    idempotencyKey: meta.idempotencyKey,
    raw: execution,
  }
}

// ── Payroll trigger ───────────────────────────────────────────────────────

export interface TriggerPayoutOptions {
  /** Run-only webhook URL of the pay-invoice executable (settings). Falls back to THYME_PAY_WEBHOOK_URL. */
  webhookUrl?: string
  /** Executable id for the management-run fallback (settings). Falls back to THYME_EXECUTABLE_ID. */
  executableId?: string
  /** Suffix of the Idempotency-Key; bump to deliberately re-send the same invoice. Default 1. */
  attempt?: number
  /** Full override of the Idempotency-Key. */
  idempotencyKey?: string
  /** Origin the task should call back; defaults to APP_URL. */
  appUrl?: string
  /** Forwarded to the task so it can refuse when the Safe balance is short. */
  safeAddress?: Address
  /** THYME_PULL_TOKEN for the task's calls back to the app; defaults to the env value. */
  pullToken?: string
  /** Send `Prefer: respond-async` and return the 202 immediately. */
  respondAsync?: boolean
  timeoutMs?: number
}

/** Custom webhook args REPLACE the executable's saved args, so every field the task needs (apiUrl, pullToken) is here. */
export function webhookArgsFor(appUrl: string, invoiceId: string, extra: PayrollTaskArgs = {}): Record<string, string> {
  return taskArgs(appUrl, extra, invoiceId)
}

/**
 * Ask Thyme to pay one invoice.
 * Preferred path: the executable's webhook URL with custom args {apiUrl, invoiceId}.
 * Fallback: POST .../run with saved args when only an API key + executable id exist
 * (pays the oldest pending payout, which is the same invoice when the queue holds one item).
 */
export async function triggerPayout(invoiceId: string, options: TriggerPayoutOptions = {}): Promise<ThymeRunOutcome> {
  const env = getThymeEnv()
  const idempotencyKey = options.idempotencyKey ?? `payout-${invoiceId}-${options.attempt ?? 1}`
  const webhookUrl = options.webhookUrl ?? env.webhookUrl
  if (webhookUrl) {
    const appUrl = options.appUrl ?? env.appUrl
    if (!appUrl) throw new ThymeApiError('APP_URL is not set; the Flow task needs it to call back', { status: 0, code: 'not_configured' })
    const result = await invokeWebhook(webhookUrl, webhookArgsFor(appUrl, invoiceId, { safeAddress: options.safeAddress, pullToken: options.pullToken ?? env.pullToken }), {
      idempotencyKey,
      respondAsync: options.respondAsync,
      timeoutMs: options.timeoutMs,
    })
    return outcomeFromWebhook(result.data, { idempotencyKey, replayed: result.replayed, requestId: result.requestId })
  }
  const executableId = options.executableId ?? env.executableId
  if (env.apiKey && executableId) {
    const client = getThymeClient(env)
    const run = await client.runExecutable(executableId, idempotencyKey)
    const execution = await client.getExecution(run.executionId)
    return outcomeFromExecution(execution, { idempotencyKey })
  }
  throw new ThymeApiError('Thyme is not configured: no webhook URL (settings / THYME_PAY_WEBHOOK_URL) and no executable id', {
    status: 0,
    code: 'not_configured',
  })
}

// ── Module-level conveniences (env-configured client) ─────────────────────

export function getExecution(executionId: string): Promise<ThymeExecution> {
  return getThymeClient().getExecution(executionId)
}

export function getExecutionLogs(executionId: string): Promise<ThymeExecutionLog[]> {
  return getThymeClient().getExecutionLogs(executionId)
}

export function listExecutions(executableId: string, options: ListExecutionsOptions = {}): Promise<ThymePage<ThymeExecution>> {
  return getThymeClient().listExecutions(executableId, options)
}

export function listProjectExecutions(projectId: string, options: ListProjectExecutionsOptions = {}): Promise<ThymePage<ThymeExecution>> {
  return getThymeClient().listProjectExecutions(projectId, options)
}

export function pollUntilTerminal(executionId: string, options: PollOptions = {}): Promise<PollResult> {
  return getThymeClient().pollUntilTerminal(executionId, options)
}
