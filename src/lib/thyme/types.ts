import type { Address, Hex } from 'viem'

/** Which rail sends the EURC. Mirrors the PAYMENT_EXECUTOR env value. */
export type PaymentExecutor = 'thyme' | 'direct'

/**
 * Execution states documented by Thyme Flow (Console -> Monitoring).
 * `submitted_unknown` means a hash exists without a resolved receipt.
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

/**
 * One execution record from the management API (GET /api/v1/executions/{id}).
 * The OpenAPI document types the body as an opaque `data` object; only `id` and
 * `status` are documented in prose. Every other field here is extracted
 * leniently by `normalizeExecution` and is UNVERIFIED against a live deployment.
 * `raw` always carries the untouched record.
 */
export interface ThymeExecution {
  id: string
  status: ThymeExecutionStatus | 'unknown'
  executableId?: string
  txHash?: Hex
  userOpHash?: Hex
  error?: string
  createdAt?: string
  updatedAt?: string
  raw: Record<string, unknown>
}

/** One captured ctx.logger line (GET /api/v1/executions/{id}/logs). Field names UNVERIFIED. */
export interface ThymeExecutionLog {
  type: 'info' | 'warn' | 'error' | 'unknown'
  message: string
  at?: string
  raw: unknown
}

/** Cursor page as documented under "Pagination" in the management API. */
export interface ThymePage<T> {
  data: T[]
  pagination: { cursor: string; isDone: boolean }
}

/** Result of asking Thyme to run the pay-invoice executable. */
export interface ThymeTriggerResult {
  mode: 'webhook' | 'management-run'
  /** HTTP 200 or 202 from Thyme. Anything else throws ThymeApiError. */
  httpStatus: number
  idempotencyKey: string
  /** True when Thyme replayed an earlier response for the same Idempotency-Key. */
  replayed: boolean
  /** Thyme's own execution id (not the task's synthetic flow-* id). */
  executionId?: string
  status: ThymeExecutionStatus | 'unknown'
  txHash?: Hex
  userOpHash?: Hex
  /** Sanitized task/submission error returned inline for failed or skipped runs. */
  error?: string
  /** 202 flows: poll this URL (it embeds the webhook secret; never log it). */
  resultUrl?: string
  requestId?: string
  raw: unknown
}

export interface PollResult {
  execution: ThymeExecution
  /** False when the timeout elapsed first (status may still be submitted/submitted_unknown). */
  terminal: boolean
  elapsedMs: number
}

/** One row of GET /api/thyme/pending (src/routes/api/thyme/pending.ts). */
export interface PendingPayout {
  payoutId: string
  invoiceId: string
  invoiceNumber: string | null
  beneficiaryId: string | null
  /** payee wallet from the invoice; the task skips rows without a valid address */
  to: string | null
  /** EURC base units (6 dp) as a decimal string, same as payouts.amount_eurc */
  amountEurc: string
  amountEur: number
  createdAt: string
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
 * `executionId` is the task's synthetic run id `flow-<seq>-<account8>`; it is the same
 * on submitted / confirmed / failed for one run, so the route can match a cron-run failure
 * through payouts.thyme_execution_id even when invoiceId/payoutId are absent.
 */
export interface ThymeCallback {
  executionId: string
  status: ThymeCallbackStatus
  invoiceId?: string
  payoutId?: string
  txHash?: Hex | null
  blockNumber?: number | null
  gasUsed?: number | null
  error?: string | null
}

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
  /** Thyme's execution id (thyme path) for the audit log and the agents page. */
  thymeExecutionId?: string
  idempotencyKey?: string
  /** Human reason: decoded Roles revert (direct) or Thyme's sanitized error. */
  error?: string
  raw?: unknown
}

export interface DirectExecutorOptions {
  /** eth_call first to capture the revert reason (default true). */
  preflight?: boolean
  /** Broadcast even when the preflight says it will revert: the "force" demo path (default true). */
  forceOnRevert?: boolean
  gasLimit?: bigint
}

export interface ExecutePayoutOptions {
  /** Defaults to PAYMENT_EXECUTOR. */
  executor?: PaymentExecutor
  /** Direct executor: the Zodiac Roles module on the Safe. Required for 'direct'. */
  rolesProxy?: Address
  /** Direct executor: the agent's role key. Required for 'direct'. */
  roleKey?: Hex
  /** Direct executor: preflight / force / gas settings. */
  direct?: DirectExecutorOptions
  /** Thyme: bump when deliberately re-sending the same invoice (Idempotency-Key suffix). */
  attempt?: number
  /** Thyme: pass the Safe so the task can refuse when the balance is short. */
  safeAddress?: Address
  /** Thyme: override APP_URL for the task's callbacks (e.g. a tunnel in local dev). */
  appUrl?: string
  /** Thyme: ask for 202 immediately instead of letting Thyme hold the request up to 55 s. */
  respondAsync?: boolean
  /** Thyme: poll until confirmed/failed/skipped. Default true. */
  waitForConfirmation?: boolean
  /** Thyme: polling budget. Default 120 s. */
  timeoutMs?: number
}
