import type { Hex } from 'viem'
import { pollUntilTerminal, pollWebhookResult, triggerPayout } from './client'
import { getThymeEnv } from './env'
import type { ExecutePayoutOptions, ExecutePayoutResult, PayoutExecutionStatus, PayoutRequest, ThymeRunOutcome } from './types'

/** Thyme execution state -> payouts.status vocabulary. */
export function mapExecutionStatus(status: string): PayoutExecutionStatus {
  switch (status) {
    case 'confirmed':
      return 'confirmed'
    case 'failed':
      return 'failed'
    case 'skipped':
      return 'skipped'
    case 'submitted':
    case 'submitted_unknown':
      return 'submitted'
    default:
      return 'pending'
  }
}

function isSettled(status: PayoutExecutionStatus): boolean {
  return status === 'confirmed' || status === 'failed' || status === 'reverted' || status === 'skipped'
}

function fromOutcome(outcome: ThymeRunOutcome): Pick<ExecutePayoutResult, 'status' | 'txHash' | 'blockNumber' | 'gasUsed' | 'error'> {
  return {
    status: mapExecutionStatus(outcome.status),
    txHash: outcome.txHash,
    blockNumber: outcome.blockNumber,
    gasUsed: outcome.gasUsed,
    error: outcome.error,
  }
}

/**
 * Send one payout through Thyme Flow: trigger the pay-invoice executable (webhook, or a
 * management run) and, by default, wait for confirmed | failed | skipped. The task itself also
 * posts submitted / confirmed / failed to /api/webhooks/thyme, so the app stays correct when the
 * wait times out. The app holds no key: Thyme executes through the Roles profile on the Safe.
 */
export async function executePayout(payout: PayoutRequest, options: ExecutePayoutOptions = {}): Promise<ExecutePayoutResult> {
  const first = await triggerPayout(payout.invoiceId, {
    webhookUrl: options.webhookUrl,
    attempt: options.attempt,
    appUrl: options.appUrl,
    safeAddress: options.safeAddress,
    pullToken: options.pullToken,
    respondAsync: options.respondAsync,
    timeoutMs: options.timeoutMs,
  })

  let outcome = fromOutcome(first)
  let raw: unknown = first.raw

  if ((options.waitForConfirmation ?? true) && !isSettled(outcome.status)) {
    if (first.resultUrl) {
      const polled = await pollWebhookResult(first.resultUrl, { timeoutMs: options.timeoutMs })
      const asOutcome = polledOutcome(polled.data, first)
      outcome = fromOutcome(asOutcome)
      raw = polled.data
    } else if (getThymeEnv().apiKey) {
      const polled = await pollUntilTerminal(first.executionId, { timeoutMs: options.timeoutMs })
      outcome = {
        status: polled.terminal ? mapExecutionStatus(polled.execution.status) : 'submitted',
        txHash: polled.execution.txHash,
        blockNumber: polled.execution.blockNumber,
        gasUsed: polled.execution.gasUsed,
        error: polled.execution.errorMessage,
      }
      raw = polled.execution
    }
  }

  return {
    executor: 'thyme',
    ...outcome,
    thymeExecutionId: first.executionId,
    idempotencyKey: first.idempotencyKey,
    raw,
  }
}

function polledOutcome(data: Awaited<ReturnType<typeof pollWebhookResult>>['data'], first: ThymeRunOutcome): ThymeRunOutcome {
  const full = 'transaction' in data ? data : undefined
  return {
    ...first,
    status: data.status,
    terminal: isSettled(mapExecutionStatus(data.status)),
    txHash: (full?.transaction?.txHash ?? undefined) as Hex | undefined,
    userOpHash: (full?.transaction?.userOpHash ?? undefined) as Hex | undefined,
    blockNumber: full?.transaction?.blockNumber ?? undefined,
    gasUsed: full?.transaction?.gasUsed ?? undefined,
    error: full?.error?.message,
    raw: data,
  }
}

export function isTxHash(value: unknown): value is Hex {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value)
}
