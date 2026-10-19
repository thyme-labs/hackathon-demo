import type { Address, Hex } from 'viem'
import { getThymeEnv, type ThymeEnv } from './env'
import {
  type PollResult,
  TERMINAL_EXECUTION_STATUSES,
  type ThymeExecution,
  type ThymeExecutionLog,
  type ThymeExecutionStatus,
  type ThymePage,
  type ThymeTriggerResult,
} from './types'

/**
 * Thyme Flow client for the payroll app.
 *
 * Verified against the public OpenAPI document (flow.thymelabs.io/docs/openapi.yaml,
 * "Reviewed against SDK 0.8.0 / CLI 0.10.0") and the docs pages for webhooks,
 * pagination and execution states:
 *   POST {THYME_PAY_WEBHOOK_URL}                      run-only credential, Idempotency-Key, 200 | 202 + resultUrl
 *   GET  /api/v1/executions/{id}                      -> { data }
 *   GET  /api/v1/executions/{id}/logs                 -> { data: [] }
 *   GET  /api/v1/executables/{id}/executions          -> { data: [], pagination: { cursor, isDone } }
 *   GET  /api/v1/executions?projectId=&status=        -> same page shape
 *   POST /api/v1/executables/{id}/run                 -> { data } (needs executables:run + owner/admin)
 * The *contents* of an execution record are not typed by the OpenAPI document, so
 * `normalizeExecution` reads a few candidate field names and keeps `raw`.
 */

const DEFAULT_TIMEOUT_MS = 15_000
const WEBHOOK_SYNC_TIMEOUT_MS = 60_000
const WEBHOOK_ASYNC_TIMEOUT_MS = 15_000

export class ThymeApiError extends Error {
  readonly status: number
  readonly code?: string
  readonly requestId?: string
  readonly body?: unknown

  constructor(message: string, status: number, code?: string, requestId?: string, body?: unknown) {
    super(message)
    this.name = 'ThymeApiError'
    this.status = status
    this.code = code
    this.requestId = requestId
    this.body = body
  }
}

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

function firstString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.length > 0) return value
    if (Array.isArray(value) && typeof value[0] === 'string' && value[0].length > 0) return value[0]
  }
  return undefined
}

function asHex(value: string | undefined): Hex | undefined {
  return value && /^0x[0-9a-fA-F]+$/.test(value) ? (value as Hex) : undefined
}

function asIsoDate(value: unknown): string | undefined {
  if (typeof value === 'number') return new Date(value).toISOString()
  if (typeof value === 'string' && value.length > 0) return value
  return undefined
}

const KNOWN_STATUSES = new Set<string>([
  'pending',
  'running',
  'simulating',
  'submitted',
  'submitted_unknown',
  'confirmed',
  'failed',
  'skipped',
])

function asStatus(value: string | undefined): ThymeExecutionStatus | 'unknown' {
  return value && KNOWN_STATUSES.has(value) ? (value as ThymeExecutionStatus) : 'unknown'
}

export function isTerminalStatus(status: string): boolean {
  return (TERMINAL_EXECUTION_STATUSES as readonly string[]).includes(status)
}

/** Lenient reader for execution records; field names other than id/status are unverified. */
export function normalizeExecution(raw: unknown): ThymeExecution {
  const record = isRecord(raw) ? raw : {}
  const nested = isRecord(record.execution) ? record.execution : undefined
  const source = nested ?? record
  const errorValue = source.error ?? source.errorMessage ?? source.failureReason
  return {
    id: firstString(source, ['id', 'executionId', '_id']) ?? '',
    status: asStatus(firstString(source, ['status', 'state'])),
    executableId: firstString(source, ['executableId', 'executable']),
    txHash: asHex(firstString(source, ['txHash', 'transactionHash', 'txHashes', 'transactionHashes'])),
    userOpHash: asHex(firstString(source, ['userOpHash', 'userOperationHash', 'userOpHashes'])),
    error:
      typeof errorValue === 'string'
        ? errorValue
        : isRecord(errorValue) && typeof errorValue.message === 'string'
          ? errorValue.message
          : undefined,
    createdAt: asIsoDate(source.createdAt ?? source._creationTime ?? source.startedAt),
    updatedAt: asIsoDate(source.updatedAt ?? source.completedAt ?? source.finishedAt),
    raw: record,
  }
}

function normalizeLog(raw: unknown): ThymeExecutionLog {
  if (typeof raw === 'string') return { type: 'unknown', message: raw, raw }
  const record = isRecord(raw) ? raw : {}
  const type = firstString(record, ['type', 'level'])
  return {
    type: type === 'info' || type === 'warn' || type === 'error' ? type : 'unknown',
    message: firstString(record, ['message', 'text', 'line']) ?? JSON.stringify(raw),
    at: asIsoDate(record.timestamp ?? record.ts ?? record.at ?? record.createdAt),
    raw,
  }
}

function managementHeaders(env: ThymeEnv, extra: Record<string, string> = {}): Record<string, string> {
  if (!env.apiKey) {
    throw new ThymeApiError('THYME_API_KEY is not set; management reads are unavailable', 0, 'not_configured')
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${env.apiKey}`,
    Accept: 'application/json',
    ...extra,
  }
  if (env.workspaceId) headers['X-Workspace-Id'] = env.workspaceId
  return headers
}

interface RequestInitLite {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  body?: unknown
  idempotencyKey?: string
  signal?: AbortSignal
}

async function managementRequest<T>(path: string, init: RequestInitLite = {}): Promise<T> {
  const env = getThymeEnv()
  const method = init.method ?? 'GET'
  const extra: Record<string, string> = {}
  if (init.body !== undefined) extra['Content-Type'] = 'application/json'
  if (init.idempotencyKey) extra['Idempotency-Key'] = init.idempotencyKey
  // The API base may carry a path prefix (".../http"), so concatenate instead of new URL(path, base).
  const url = `${env.apiUrl}${path}`
  const response = await fetch(url, {
    method,
    headers: managementHeaders(env, extra),
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: init.signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  })
  const requestId = response.headers.get('x-request-id') ?? undefined
  const json = parseJson(await response.text())
  if (!response.ok) {
    const error = isRecord(json) ? json : {}
    throw new ThymeApiError(
      typeof error.error === 'string' ? error.error : `Thyme API ${method} ${path} failed with HTTP ${response.status}`,
      response.status,
      typeof error.code === 'string' ? error.code : undefined,
      requestId ?? (typeof error.requestId === 'string' ? error.requestId : undefined),
      json,
    )
  }
  return json as T
}

function buildQuery(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value))
  }
  const text = search.toString()
  return text ? `?${text}` : ''
}

export async function getExecution(executionId: string): Promise<ThymeExecution> {
  const response = await managementRequest<{ data: unknown }>(`/api/v1/executions/${encodeURIComponent(executionId)}`)
  return normalizeExecution(response.data)
}

export async function getExecutionLogs(executionId: string): Promise<ThymeExecutionLog[]> {
  const response = await managementRequest<{ data: unknown[] }>(
    `/api/v1/executions/${encodeURIComponent(executionId)}/logs`,
  )
  return (Array.isArray(response.data) ? response.data : []).map(normalizeLog)
}

export interface ListExecutionsOptions {
  limit?: number
  cursor?: string
}

/** Runs of one executable, newest first (server order). Follow `pagination.cursor` until `isDone`. */
export async function listExecutions(
  executableId: string,
  options: ListExecutionsOptions = {},
): Promise<ThymePage<ThymeExecution>> {
  const query = buildQuery({ limit: options.limit, cursor: options.cursor })
  const response = await managementRequest<ThymePage<unknown>>(
    `/api/v1/executables/${encodeURIComponent(executableId)}/executions${query}`,
  )
  return {
    data: (Array.isArray(response.data) ? response.data : []).map(normalizeExecution),
    pagination: response.pagination ?? { cursor: '', isDone: true },
  }
}

export interface ListProjectExecutionsOptions extends ListExecutionsOptions {
  status?: Exclude<ThymeExecutionStatus, 'submitted_unknown'>
}

/** Project-wide list with the documented status filter (submitted_unknown is not filterable). */
export async function listProjectExecutions(
  projectId: string,
  options: ListProjectExecutionsOptions = {},
): Promise<ThymePage<ThymeExecution>> {
  const query = buildQuery({ projectId, status: options.status, limit: options.limit, cursor: options.cursor })
  const response = await managementRequest<ThymePage<unknown>>(`/api/v1/executions${query}`)
  return {
    data: (Array.isArray(response.data) ? response.data : []).map(normalizeExecution),
    pagination: response.pagination ?? { cursor: '', isDone: true },
  }
}

/**
 * Queue a real run with the executable's SAVED args (no invoiceId): the task pays the
 * oldest pending payout. Needs executables:run and owner/admin membership on the key.
 */
export async function runExecutable(executableId: string, idempotencyKey: string): Promise<ThymeTriggerResult> {
  const response = await managementRequest<{ data: unknown }>(
    `/api/v1/executables/${encodeURIComponent(executableId)}/run`,
    { method: 'POST', idempotencyKey },
  )
  const execution = normalizeExecution(response.data)
  return {
    mode: 'management-run',
    httpStatus: 200,
    idempotencyKey,
    replayed: false,
    executionId: execution.id || undefined,
    status: execution.status === 'unknown' ? 'pending' : execution.status,
    txHash: execution.txHash,
    userOpHash: execution.userOpHash,
    error: execution.error,
    raw: response,
  }
}

export interface TriggerPayoutOptions {
  /** Suffix of the Idempotency-Key; bump to deliberately re-send the same invoice. Default 1. */
  attempt?: number
  /** Full override of the Idempotency-Key. */
  idempotencyKey?: string
  /** Origin the task should call back; defaults to APP_URL. */
  appUrl?: string
  /** Forwarded to the task so it can refuse when the Safe balance is short. */
  safeAddress?: Address
  /** Send `Prefer: respond-async` and return the 202 immediately. */
  respondAsync?: boolean
  timeoutMs?: number
}

function webhookArgs(appUrl: string, invoiceId: string, safeAddress?: Address): Record<string, string> {
  // Custom webhook args REPLACE the executable's saved args, so every required
  // schema field (apiUrl) must be present here.
  const args: Record<string, string> = { apiUrl: appUrl, invoiceId }
  if (safeAddress) args.safeAddress = safeAddress
  return args
}

function readWebhookData(json: unknown): Record<string, unknown> {
  if (!isRecord(json)) return {}
  return isRecord(json.data) ? json.data : json
}

async function triggerViaWebhook(
  env: ThymeEnv,
  webhookUrl: string,
  invoiceId: string,
  idempotencyKey: string,
  options: TriggerPayoutOptions,
): Promise<ThymeTriggerResult> {
  const appUrl = options.appUrl ?? env.appUrl
  if (!appUrl) {
    throw new ThymeApiError('APP_URL is not set; the Flow task needs it to call back', 0, 'not_configured')
  }
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'Idempotency-Key': idempotencyKey,
  }
  if (options.respondAsync) headers.Prefer = 'respond-async'
  const timeoutMs = options.timeoutMs ?? (options.respondAsync ? WEBHOOK_ASYNC_TIMEOUT_MS : WEBHOOK_SYNC_TIMEOUT_MS)

  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(webhookArgs(appUrl, invoiceId, options.safeAddress)),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const requestId = response.headers.get('x-request-id') ?? undefined
  const replayed = response.headers.get('idempotency-replayed') === 'true'
  const json = parseJson(await response.text())

  if (!response.ok) {
    const error = isRecord(json) ? json : {}
    throw new ThymeApiError(
      typeof error.error === 'string' ? error.error : `Thyme webhook failed with HTTP ${response.status}`,
      response.status,
      typeof error.code === 'string' ? error.code : undefined,
      requestId,
      json,
    )
  }

  const data = readWebhookData(json)
  const execution = normalizeExecution(data)
  const resultUrl = firstString(data, ['resultUrl']) ?? response.headers.get('location') ?? undefined
  return {
    mode: 'webhook',
    httpStatus: response.status,
    idempotencyKey,
    replayed,
    executionId: execution.id || undefined,
    status: execution.status === 'unknown' && response.status === 202 ? 'pending' : execution.status,
    txHash: execution.txHash,
    userOpHash: execution.userOpHash,
    error: execution.error,
    resultUrl: response.status === 202 ? resultUrl : undefined,
    requestId,
    raw: json,
  }
}

/**
 * Ask Thyme to pay one invoice.
 * Preferred path: the executable's webhook URL with custom args {apiUrl, invoiceId}.
 * Fallback: POST .../run with saved args when only THYME_API_KEY + THYME_EXECUTABLE_ID exist
 * (pays the oldest pending payout, which is the same invoice when the queue holds one item).
 */
export async function triggerPayout(
  invoiceId: string,
  options: TriggerPayoutOptions = {},
): Promise<ThymeTriggerResult> {
  const env = getThymeEnv()
  const idempotencyKey = options.idempotencyKey ?? `payout-${invoiceId}-${options.attempt ?? 1}`
  if (env.webhookUrl) {
    return triggerViaWebhook(env, env.webhookUrl, invoiceId, idempotencyKey, options)
  }
  if (env.apiKey && env.executableId) {
    return runExecutable(env.executableId, idempotencyKey)
  }
  throw new ThymeApiError(
    'Thyme is not configured: set THYME_PAY_WEBHOOK_URL (preferred) or THYME_API_KEY + THYME_EXECUTABLE_ID',
    0,
    'not_configured',
  )
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

export interface PollOptions {
  intervalMs?: number
  timeoutMs?: number
  signal?: AbortSignal
  onUpdate?: (execution: ThymeExecution) => void
}

/** Poll GET /api/v1/executions/{id} until confirmed | failed | skipped, or until the budget runs out. */
export async function pollUntilTerminal(executionId: string, options: PollOptions = {}): Promise<PollResult> {
  const intervalMs = options.intervalMs ?? 2_000
  const timeoutMs = options.timeoutMs ?? 120_000
  const startedAt = Date.now()
  for (;;) {
    const execution = await getExecution(executionId)
    options.onUpdate?.(execution)
    const elapsedMs = Date.now() - startedAt
    if (isTerminalStatus(execution.status)) return { execution, terminal: true, elapsedMs }
    if (elapsedMs >= timeoutMs) return { execution, terminal: false, elapsedMs }
    await sleep(intervalMs, options.signal)
  }
}

/**
 * Poll a webhook `resultUrl` (202 flow) without a management key. Thyme answers 202 with
 * Retry-After while the run is in progress and 200 with the final sanitized result.
 */
export async function pollWebhookResult(resultUrl: string, options: PollOptions = {}): Promise<PollResult> {
  const timeoutMs = options.timeoutMs ?? 120_000
  const startedAt = Date.now()
  let last: ThymeExecution = normalizeExecution({ status: 'pending' })
  for (;;) {
    const response = await fetch(resultUrl, {
      headers: { Accept: 'application/json' },
      signal: options.signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    })
    const json = parseJson(await response.text())
    if (response.ok && response.status !== 202) {
      last = normalizeExecution(readWebhookData(json))
      options.onUpdate?.(last)
      return { execution: last, terminal: isTerminalStatus(last.status), elapsedMs: Date.now() - startedAt }
    }
    if (response.status !== 202) {
      const error = isRecord(json) ? json : {}
      throw new ThymeApiError(
        typeof error.error === 'string' ? error.error : `Thyme result poll failed with HTTP ${response.status}`,
        response.status,
        typeof error.code === 'string' ? error.code : undefined,
        response.headers.get('x-request-id') ?? undefined,
        json,
      )
    }
    last = normalizeExecution(readWebhookData(json))
    options.onUpdate?.(last)
    const elapsedMs = Date.now() - startedAt
    if (elapsedMs >= timeoutMs) return { execution: last, terminal: false, elapsedMs }
    const retryAfter = Number(response.headers.get('retry-after') ?? '2')
    await sleep((Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 2) * 1_000, options.signal)
  }
}
