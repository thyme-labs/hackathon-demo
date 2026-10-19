import type { Hex } from 'viem'
import { PayoutRejectedError, sendPayout } from '../chain/agentSigner'
import { pollUntilTerminal, pollWebhookResult, triggerPayout } from './client'
import { getThymeEnv } from './env'
import type {
  ExecutePayoutOptions,
  ExecutePayoutResult,
  PayoutExecutionStatus,
  PayoutRequest,
  ThymeExecution,
} from './types'

type Outcome = Pick<ExecutePayoutResult, 'status' | 'txHash' | 'error'>

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

function fromExecution(execution: ThymeExecution, terminal: boolean): Outcome {
  return {
    status: terminal ? mapExecutionStatus(execution.status) : 'submitted',
    txHash: execution.txHash,
    error: execution.error,
  }
}

function isSettled(status: PayoutExecutionStatus): boolean {
  return status === 'confirmed' || status === 'failed' || status === 'reverted' || status === 'skipped'
}

async function executeViaThyme(payout: PayoutRequest, options: ExecutePayoutOptions): Promise<ExecutePayoutResult> {
  const trigger = await triggerPayout(payout.invoiceId, {
    attempt: options.attempt,
    appUrl: options.appUrl,
    safeAddress: options.safeAddress,
    respondAsync: options.respondAsync,
  })

  let outcome: Outcome = {
    status: mapExecutionStatus(trigger.status),
    txHash: trigger.txHash,
    error: trigger.error,
  }
  let execution: ThymeExecution | undefined

  if ((options.waitForConfirmation ?? true) && !isSettled(outcome.status)) {
    const current = getThymeEnv()
    if (trigger.executionId && current.apiKey) {
      const polled = await pollUntilTerminal(trigger.executionId, { timeoutMs: options.timeoutMs })
      execution = polled.execution
      outcome = fromExecution(execution, polled.terminal)
    } else if (trigger.resultUrl) {
      const polled = await pollWebhookResult(trigger.resultUrl, { timeoutMs: options.timeoutMs })
      execution = polled.execution
      outcome = fromExecution(execution, polled.terminal)
    }
  }

  return {
    executor: 'thyme',
    ...outcome,
    thymeExecutionId: trigger.executionId ?? (execution?.id || undefined),
    idempotencyKey: trigger.idempotencyKey,
    raw: execution?.raw ?? trigger.raw,
  }
}

async function executeDirect(payout: PayoutRequest, options: ExecutePayoutOptions): Promise<ExecutePayoutResult> {
  if (!options.rolesProxy || !options.roleKey) {
    throw new Error('Direct executor needs rolesProxy (Roles module on the Safe) and roleKey (agent role key)')
  }
  try {
    // src/lib/chain/agentSigner.ts: sendPayout(rolesProxy, roleKey, payee, amountEurc, opts?) -> PayoutResult.
    // A mandate rejection resolves with status 'reverted' and a decoded revert; it does not throw.
    const result = await sendPayout(
      options.rolesProxy,
      options.roleKey,
      payout.payee,
      payout.amountEurcUnits,
      options.direct,
    )
    return {
      executor: 'direct',
      status: result.status === 'confirmed' ? 'confirmed' : 'reverted',
      txHash: result.txHash,
      blockNumber: Number(result.blockNumber),
      gasUsed: result.gasUsed.toString(),
      explorerUrl: result.explorerUrl,
      error: result.error ?? result.revert?.human,
      raw: result,
    }
  } catch (error) {
    // Preflight said it would revert and forceOnRevert was false: nothing was broadcast.
    if (error instanceof PayoutRejectedError) {
      return { executor: 'direct', status: 'failed', error: error.revert.human, raw: error.revert }
    }
    throw error
  }
}

/**
 * Send one payout through the configured rail.
 * - thyme: trigger the pay-invoice executable (webhook or management run) and, by default,
 *   wait for confirmed | failed | skipped. The task itself also posts to /api/webhooks/thyme.
 * - direct: the agent EOA calls execTransactionWithRole on our own Roles module and waits
 *   for the receipt; a revert comes back as status 'reverted' with the decoded reason.
 */
export async function executePayout(
  payout: PayoutRequest,
  options: ExecutePayoutOptions = {},
): Promise<ExecutePayoutResult> {
  const executor = options.executor ?? getThymeEnv().paymentExecutor
  if (executor === 'direct') return executeDirect(payout, options)
  return executeViaThyme(payout, options)
}

export function isTxHash(value: unknown): value is Hex {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value)
}
