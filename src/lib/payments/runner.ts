// Server-only payment agent: turns `pending` payouts into EURC transfers.
//   thyme     -> hands the payout to Thyme Flow (the executable's run-only webhook) and waits for the
//                result; Thyme executes EURC.transfer through the Roles profile on the user's own Safe.
//                The app holds no key. The task's callbacks (/api/webhooks/thyme) are the fast path.
//   simulated -> Thyme not configured / onboarding simulated: the payout is recorded as `simulated`
//                with a labelled placeholder hash so the whole flow still runs in mock mode.
import { type Address, getAddress, type Hex, isAddress, keccak256, toHex } from 'viem'
import { type PaymentExecutorName, serverEnv } from '../env'
import type { PayoutActionResult } from '../server/dto'
import { appendAudit, beneficiaries, beneficiaryWallets, invoices, nowIso, payouts, settings } from '../store/repos'
import type { AuditActor, Invoice, Payout } from '../store/types'
import { THYME_SETTINGS_KEYS } from '../thyme/types'

if (typeof window !== 'undefined') {
  throw new Error('src/lib/payments/runner.ts is server-only')
}

export const SIMULATED_GAS_USED = 140_000
const SIMULATED_DELAY_MS = 1_800
const REFUSAL_DELAY_MS = 1_200
/** One tick waits this long for Thyme to settle; afterwards the callback or the next tick finishes the row. */
const THYME_WAIT_MS = 150_000
const LIMIT_WINDOW_MS = 30 * 86_400_000
/** A payout pending or submitted for longer than this without a result is "stuck": the owner may retry, check or discard it. */
export const STUCK_AFTER_MS = 5 * 60_000

export type ExecutionMode = 'thyme' | 'simulated'

const addr = (v: string | null | undefined): Address | null => (v && isAddress(v) ? getAddress(v) : null)

export function readSafeAddress(): Address | null {
  return addr(settings.get(THYME_SETTINGS_KEYS.safeAddress))
}

/** Thyme ids the onboarding stored in settings (the webhook URL is a credential, never logged). */
export function readThymeIds(): { executableId: string | null; webhookUrl: string | null; profileId: string | null; simulatedAt: string | null } {
  return {
    executableId: settings.get(THYME_SETTINGS_KEYS.executableId),
    webhookUrl: settings.get(THYME_SETTINGS_KEYS.webhookUrl),
    profileId: settings.get(THYME_SETTINGS_KEYS.profileId),
    simulatedAt: settings.get(THYME_SETTINGS_KEYS.simulatedAt),
  }
}

/** Which path a payout takes right now. */
export async function resolveExecutionMode(executor: PaymentExecutorName = serverEnv.paymentExecutor()): Promise<{ mode: ExecutionMode; reason: string }> {
  if (executor !== 'thyme') return { mode: 'simulated', reason: 'PAYMENT_EXECUTOR=simulated · labelled fake payouts' }
  const { getThymeTriggerMode } = await import('../thyme/env')
  const ids = readThymeIds()
  const trigger = getThymeTriggerMode(undefined, ids)
  if (trigger === 'webhook') return { mode: 'thyme', reason: 'Thyme Flow · webhook trigger' }
  if (trigger === 'management-run') return { mode: 'thyme', reason: 'Thyme Flow · management run' }
  if (ids.simulatedAt) return { mode: 'simulated', reason: 'simulated onboarding · no wallet, no Thyme' }
  return { mode: 'simulated', reason: 'Safe not enabled with Thyme yet' }
}

export function simulatedTxHash(seed: string): Hex {
  return keccak256(toHex(`thyme-payroll:simulated:${seed}`))
}

/** Pending or submitted for longer than STUCK_AFTER_MS without a result. */
export function isPayoutStuck(p: Pick<Payout, 'status' | 'submitted_at' | 'created_at'>, now = Date.now()): boolean {
  if (p.status !== 'pending' && p.status !== 'submitted') return false
  const since = new Date(p.submitted_at ?? p.created_at).getTime()
  return Number.isFinite(since) && now - since > STUCK_AFTER_MS
}

function isSettled(p: Payout): boolean {
  return p.status === 'confirmed' || p.status === 'failed' || p.status === 'reverted'
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function actionResult(payout: Payout, message: string, extra: Partial<PayoutActionResult> = {}): PayoutActionResult {
  return {
    payoutId: payout.id,
    status: payout.status,
    message,
    thymeStatus: null,
    txHash: payout.tx_hash,
    error: payout.error,
    simulated: payout.simulated === 1,
    activePayoutId: isSettled(payout) ? null : payout.id,
    ...extra,
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface SettleInput {
  payout: Payout
  invoice: Invoice
  status: 'confirmed' | 'reverted' | 'failed'
  txHash: Hex | null
  blockNumber: number | null
  gasUsed: number | null
  effectiveGasPriceWei: string | null
  error: string | null
  simulated: boolean
  /** Who decided: 'chain' for a receipt, 'thyme' for a Thyme-side failure, 'agent' for a refusal before the rail. */
  actor?: AuditActor
  executionId?: string | null
  thymeExecutionId?: string
}

function settle(input: SettleInput): Payout {
  const ts = nowIso()
  const updated = payouts.setStatus(input.payout.id, input.status, {
    tx_hash: input.txHash,
    block_number: input.blockNumber,
    gas_used: input.gasUsed,
    effective_gas_price_wei: input.effectiveGasPriceWei,
    error: input.error,
    confirmed_at: input.status === 'confirmed' ? ts : null,
    simulated: input.simulated ? 1 : 0,
    thyme_execution_id: input.executionId ?? input.payout.thyme_execution_id,
  }) as Payout
  if (input.status === 'confirmed') {
    invoices.setStatus(input.invoice.id, 'paid')
    if (input.payout.beneficiary_id) beneficiaries.recordPaid(input.payout.beneficiary_id, input.payout.amount_eur, ts)
  } else {
    invoices.setStatus(input.invoice.id, 'failed', { decision_text: `${input.invoice.decision_text ?? ''}\n\nPayment ${input.status}: ${input.error ?? 'unknown error'}`.trim() })
  }
  appendAudit({
    actor: input.actor ?? (input.simulated ? 'agent' : 'chain'),
    event: `payout.${input.status}`,
    invoiceId: input.invoice.id,
    beneficiaryId: input.payout.beneficiary_id,
    details: {
      payout_id: input.payout.id,
      amount_eur: input.payout.amount_eur,
      amount_eurc: input.payout.amount_eurc,
      tx_hash: input.txHash,
      block_number: input.blockNumber,
      gas_used: input.gasUsed,
      error: input.error,
      simulated: input.simulated,
      executor: input.payout.executor,
      thyme_execution_id: input.thymeExecutionId ?? null,
    },
  })
  return updated
}

/** The last error/warn lines Thyme captured from the task (ctx.logger), when the API key can read them. */
async function readExecutionErrorLogs(executionId: string | undefined): Promise<string | null> {
  if (!executionId) return null
  try {
    const { getThymeEnv } = await import('../thyme/env')
    if (!getThymeEnv().apiKey) return null
    const { getExecutionLogs } = await import('../thyme/client')
    const logs = await getExecutionLogs(executionId)
    const lines = logs.filter((l) => l.level === 'error' || l.level === 'warn').map((l) => l.message)
    return lines.length > 0 ? lines.slice(-2).join(' · ') : null
  } catch {
    return null
  }
}

/** Confirmed and in-flight EUR for a beneficiary in the last 30 days, excluding one payout. */
function spentLast30Days(beneficiaryId: string, excludePayoutId: string): number {
  const since = new Date(Date.now() - LIMIT_WINDOW_MS).toISOString()
  return payouts.spentEurSince(beneficiaryId, since, excludePayoutId)
}

/**
 * Agent-side rules the rail enforces before anything reaches Thyme: the recipient must be an APPROVED wallet
 * of an active beneficiary (never a wallet still pending owner approval) and the amount must fit the 30-day
 * limit. The chain does not know these; Thyme's Roles scope only guarantees EURC.transfer from this Safe.
 */
function agentRefusal(payout: Payout, to: Address, approved: Address[], beneficiary: ReturnType<typeof beneficiaries.get>): string | null {
  if (!beneficiary) return `no registered beneficiary for this payout; the rail only pays approved wallets on file (agent rule)`
  if (approved.length === 0) return `${beneficiary.name} has no approved wallet on file (agent rule)`
  if (!approved.some((a) => a.toLowerCase() === to.toLowerCase())) {
    return `${to} is not an approved wallet of ${beneficiary.name} (approved: ${approved.join(', ')}). A wallet printed on an invoice is paid only after the owner approved it on the Beneficiaries page. Thyme only ever receives approved wallets from /api/thyme/pending, so even a fooled agent cannot pay it (agent rule). On chain, Thyme's Roles scope allows nothing but EURC.transfer from this Safe (chain rule).`
  }
  if (beneficiary.status !== 'active') return `${beneficiary.name} is ${beneficiary.status}; only active beneficiaries are paid (agent rule)`
  const spent = spentLast30Days(beneficiary.id, payout.id)
  if (spent + payout.amount_eur > beneficiary.monthly_limit_eur + 0.005) {
    return `€${payout.amount_eur.toFixed(2)} exceeds the remaining 30-day limit of ${beneficiary.name}: €${(beneficiary.monthly_limit_eur - spent).toFixed(2)} of €${beneficiary.monthly_limit_eur.toFixed(2)} left (agent rule)`
  }
  return null
}

/**
 * Execute one pending payout to an APPROVED wallet of the beneficiary: the wallet printed on the invoice when the
 * owner approved it, else the primary wallet on file. A pending wallet is never paid. Returns the settled (or
 * still in-flight) row; payouts.to_wallet records the recipient.
 */
export async function executeOnePayout(payoutId: string, opts: { force?: boolean; to?: Address } = {}): Promise<Payout> {
  const payout = payouts.get(payoutId)
  if (!payout) throw new Error(`payout ${payoutId} not found`)
  if (payout.status !== 'pending') return payout
  const invoice = invoices.get(payout.invoice_id)
  if (!invoice) throw new Error(`invoice ${payout.invoice_id} not found`)
  const beneficiary = payout.beneficiary_id ? beneficiaries.get(payout.beneficiary_id) : null
  const approved = beneficiary ? beneficiaryWallets.approvedFor(beneficiary.id).map((w) => addr(w.wallet)).filter((a): a is Address => a !== null) : []
  const selected = beneficiary ? addr(beneficiaryWallets.selectForPayout(beneficiary.id, invoice.payee_wallet)) : null
  const to = opts.to ?? selected ?? addr(beneficiary?.wallet)
  if (!to) {
    return settle({ payout, invoice, status: 'failed', txHash: null, blockNumber: null, gasUsed: null, effectiveGasPriceWei: null, error: 'beneficiary has no approved wallet on file', simulated: false, actor: 'agent' })
  }

  const { mode, reason } = await resolveExecutionMode()
  const ts = nowIso()

  const refusal = agentRefusal(payout, to, approved, beneficiary)
  if (refusal) {
    appendAudit({ actor: 'agent', event: 'payout.refused', invoiceId: invoice.id, beneficiaryId: payout.beneficiary_id, details: { payout_id: payout.id, to, amount_eurc: payout.amount_eurc, mode, force: opts.force ?? false, reason: refusal } })
    await sleep(REFUSAL_DELAY_MS)
    return settle({ payout, invoice, status: 'failed', txHash: null, blockNumber: null, gasUsed: null, effectiveGasPriceWei: null, error: `Payment agent refused: ${refusal}`, simulated: mode === 'simulated', actor: 'agent' })
  }

  if (mode === 'simulated') {
    payouts.setStatus(payout.id, 'submitted', { submitted_at: ts, to_wallet: to.toLowerCase() })
    invoices.setStatus(invoice.id, 'paying')
    appendAudit({ actor: 'agent', event: 'payout.submitted', invoiceId: invoice.id, beneficiaryId: payout.beneficiary_id, details: { payout_id: payout.id, to, amount_eurc: payout.amount_eurc, mode, reason, force: opts.force ?? false } })
    const submitted = payouts.get(payout.id) as Payout
    await sleep(SIMULATED_DELAY_MS)
    return settle({ payout: submitted, invoice, status: 'confirmed', txHash: simulatedTxHash(payout.id), blockNumber: null, gasUsed: SIMULATED_GAS_USED, effectiveGasPriceWei: null, error: null, simulated: true })
  }

  // Hand the payout to Thyme. The row stays `pending` because the task pulls pending rows from
  // /api/thyme/pending; submitted_at marks the hand-over so the next tick does not trigger it again.
  payouts.update(payout.id, { submitted_at: ts, error: null, to_wallet: to.toLowerCase() })
  invoices.setStatus(invoice.id, 'paying')
  appendAudit({ actor: 'agent', event: 'payout.submitted', invoiceId: invoice.id, beneficiaryId: payout.beneficiary_id, details: { payout_id: payout.id, to, amount_eurc: payout.amount_eurc, mode, reason, force: opts.force ?? false } })

  const ids = readThymeIds()
  const { executePayout } = await import('../thyme/executor')
  const { getThymeEnv } = await import('../thyme/env')
  const env = getThymeEnv()
  try {
    const result = await executePayout(
      { payoutId: payout.id, invoiceId: invoice.id, payee: to, amountEurcUnits: BigInt(payout.amount_eurc) },
      { webhookUrl: ids.webhookUrl ?? undefined, attempt: payout.attempt, safeAddress: readSafeAddress() ?? undefined, appUrl: env.appUrl, pullToken: env.pullToken, timeoutMs: THYME_WAIT_MS },
    )
    if (result.thymeExecutionId) settings.set(THYME_SETTINGS_KEYS.lastExecutionId, result.thymeExecutionId)
    appendAudit({
      actor: 'thyme',
      event: 'payout.thyme_execution',
      invoiceId: invoice.id,
      beneficiaryId: payout.beneficiary_id,
      details: { payout_id: payout.id, execution_id: result.thymeExecutionId ?? null, status: result.status, idempotency_key: result.idempotencyKey ?? null, tx_hash: result.txHash ?? null, error: result.error ?? null },
    })

    const fresh = payouts.get(payout.id) as Payout
    if (fresh.status === 'confirmed' || fresh.status === 'failed' || fresh.status === 'reverted') {
      // The task's callback settled the row first; only fill in what it did not carry.
      payouts.update(payout.id, {
        tx_hash: fresh.tx_hash ?? result.txHash ?? null,
        block_number: fresh.block_number ?? result.blockNumber ?? null,
        gas_used: fresh.gas_used ?? (result.gasUsed ? Number(result.gasUsed) : null),
      })
      return payouts.get(payout.id) as Payout
    }
    if (result.status === 'confirmed') {
      return settle({ payout: fresh, invoice, status: 'confirmed', txHash: result.txHash ?? null, blockNumber: result.blockNumber ?? null, gasUsed: result.gasUsed ? Number(result.gasUsed) : null, effectiveGasPriceWei: null, error: null, simulated: false, actor: 'chain', thymeExecutionId: result.thymeExecutionId })
    }
    if (result.status === 'failed' || result.status === 'reverted' || result.status === 'skipped') {
      const base = result.error ?? `Thyme execution ${result.status}`
      const logs = await readExecutionErrorLogs(result.thymeExecutionId)
      return settle({
        payout: fresh,
        invoice,
        status: result.status === 'reverted' ? 'reverted' : 'failed',
        txHash: result.txHash ?? null,
        blockNumber: result.blockNumber ?? null,
        gasUsed: result.gasUsed ? Number(result.gasUsed) : null,
        effectiveGasPriceWei: null,
        error: logs && !base.includes(logs) ? `${base} — ${logs}` : base,
        simulated: false,
        actor: result.status === 'reverted' ? 'chain' : 'thyme',
        thymeExecutionId: result.thymeExecutionId,
      })
    }
    // Still running after the wait: the callback or the next tick's re-trigger (same Idempotency-Key, replayed) finishes it.
    payouts.update(payout.id, { thyme_execution_id: fresh.thyme_execution_id ?? result.thymeExecutionId ?? null, tx_hash: fresh.tx_hash ?? result.txHash ?? null })
    return payouts.get(payout.id) as Payout
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // The trigger itself failed (network, executable paused, ...). Leave the row pending: the cron run
    // picks it up within a minute, and the next tick retries the webhook with the same Idempotency-Key.
    payouts.update(payout.id, { error: `Thyme trigger failed: ${message}` })
    invoices.setStatus(invoice.id, 'approved')
    appendAudit({ actor: 'thyme', event: 'payout.trigger_failed', invoiceId: invoice.id, beneficiaryId: payout.beneficiary_id, details: { payout_id: payout.id, error: message } })
    return payouts.get(payout.id) as Payout
  }
}

/**
 * "Check status": re-read the Thyme execution recorded on a payout and settle the row when Thyme has a terminal
 * answer (the callback may have been lost). Idempotent: a settled row is never changed, only reported.
 */
export async function reconcilePayout(payoutId: string): Promise<PayoutActionResult> {
  const payout = payouts.get(payoutId)
  if (!payout) throw new Error(`payout ${payoutId} not found`)
  if (isSettled(payout)) return actionResult(payout, `Already ${payout.status}; nothing to check`)
  if (payout.simulated === 1) return actionResult(payout, 'Simulated payout: there is no Thyme execution to read')
  if (!payout.thyme_execution_id) {
    return actionResult(payout, payout.error ? `No Thyme execution yet: ${payout.error}` : 'No Thyme execution recorded yet: the trigger has not gone through. Retry sends it again.')
  }
  const { getThymeEnv } = await import('../thyme/env')
  if (!getThymeEnv().apiKey) return actionResult(payout, 'THYME_API_KEY is not set: the execution cannot be read. Wait for the callback or discard the payout.')
  const invoice = invoices.get(payout.invoice_id)
  if (!invoice) throw new Error(`invoice ${payout.invoice_id} not found`)
  const { getExecution } = await import('../thyme/client')
  const { mapExecutionStatus } = await import('../thyme/executor')
  let execution: Awaited<ReturnType<typeof getExecution>>
  try {
    execution = await getExecution(payout.thyme_execution_id)
  } catch (error) {
    const { describeThymeError } = await import('../server/thymeOnboarding')
    const message = describeThymeError(error)
    appendAudit({ actor: 'thyme', event: 'payout.status_check_failed', invoiceId: payout.invoice_id, beneficiaryId: payout.beneficiary_id, details: { payout_id: payout.id, execution_id: payout.thyme_execution_id, error: message } })
    throw new Error(message)
  }
  const mapped = mapExecutionStatus(execution.status)
  appendAudit({ actor: 'thyme', event: 'payout.status_checked', invoiceId: payout.invoice_id, beneficiaryId: payout.beneficiary_id, details: { payout_id: payout.id, execution_id: execution._id, thyme_status: execution.status, tx_hash: execution.txHash ?? null, error: execution.errorMessage ?? null } })
  const gasUsed = execution.gasUsed ? Number(execution.gasUsed) : null
  if (mapped === 'confirmed') {
    const settled = settle({ payout, invoice, status: 'confirmed', txHash: execution.txHash ?? null, blockNumber: execution.blockNumber ?? null, gasUsed, effectiveGasPriceWei: null, error: null, simulated: false, actor: 'chain', thymeExecutionId: execution._id })
    return actionResult(settled, 'Thyme confirmed the transfer; the payout is now confirmed', { thymeStatus: execution.status })
  }
  if (mapped === 'failed' || mapped === 'skipped') {
    const base = execution.errorMessage ?? `Thyme execution ${execution.status}`
    const logs = await readExecutionErrorLogs(execution._id)
    const settled = settle({ payout, invoice, status: 'failed', txHash: execution.txHash ?? null, blockNumber: execution.blockNumber ?? null, gasUsed, effectiveGasPriceWei: null, error: logs && !base.includes(logs) ? `${base} — ${logs}` : base, simulated: false, actor: 'thyme', thymeExecutionId: execution._id })
    return actionResult(settled, `Thyme reports ${execution.status}; the payout is marked failed and can be retried`, { thymeStatus: execution.status })
  }
  // Still in flight at Thyme: mirror the hash and the submitted state, nothing else.
  const refreshed = payouts.setStatus(payout.id, mapped === 'submitted' ? 'submitted' : payout.status, { tx_hash: execution.txHash ?? payout.tx_hash, submitted_at: payout.submitted_at ?? (mapped === 'submitted' ? nowIso() : null) }) as Payout
  if (mapped === 'submitted') invoices.setStatus(invoice.id, 'paying')
  return actionResult(refreshed, `Still ${execution.status} at Thyme; the callback or the next check settles it`, { thymeStatus: execution.status })
}

/** True when the stored checklist has a failing entry: the agent's verdict stands until the checks are re-run. */
function hasFailedChecks(invoice: Invoice): boolean {
  if (!invoice.checklist_json) return false
  try {
    const snapshot = JSON.parse(invoice.checklist_json) as { entries?: { status?: string }[] }
    return (snapshot.entries ?? []).some((e) => e.status === 'fail')
  } catch {
    return false
  }
}

function inFlightSibling(invoiceId: string, excludeId: string): Payout | null {
  return payouts.byInvoice(invoiceId).find((p) => p.id !== excludeId && (p.status === 'pending' || p.status === 'submitted')) ?? null
}

/**
 * "Retry payout": a failed or reverted row gets a new pending payout with the next attempt number (a NEW
 * Idempotency-Key, so Thyme starts a fresh run instead of replaying); a stuck pending row is re-armed in place
 * with the next attempt. A row Thyme still reports as running is never retried (that could pay twice).
 * Safe to click twice: a second click finds the in-flight row and reports it.
 */
export async function retryPayout(payoutId: string): Promise<PayoutActionResult> {
  const payout = payouts.get(payoutId)
  if (!payout) throw new Error(`payout ${payoutId} not found`)
  const invoice = invoices.get(payout.invoice_id)
  if (!invoice) throw new Error(`invoice ${payout.invoice_id} not found`)
  if (payout.status === 'confirmed') return actionResult(payout, 'Already confirmed; nothing to retry')
  if (invoice.status === 'paid' || payouts.byInvoice(invoice.id).some((p) => p.status === 'confirmed')) {
    return actionResult(payout, 'This invoice is already paid; a retry would pay it twice')
  }
  if (invoice.status === 'rejected' || (hasFailedChecks(invoice) && invoice.override !== 1)) {
    // The compliance agent stopped this invoice (e.g. the forced fraud demo): the rail never retries it.
    // An owner override ("Send anyway", audit owner.override) is the one documented exception.
    return actionResult(payout, 'The checks stopped this invoice; nothing is retried. Re-run the checks or register the right wallet first.')
  }
  const sibling = inFlightSibling(invoice.id, payout.id)
  if (sibling) return actionResult(sibling, `A payout for this invoice is already ${sibling.status}`, { activePayoutId: sibling.id })

  // Anything Thyme may still be running: read it first, retry only when Thyme itself says it is over.
  if (payout.thyme_execution_id && payout.simulated !== 1) {
    let checked: PayoutActionResult
    try {
      checked = await reconcilePayout(payout.id)
    } catch (error) {
      checked = actionResult(payout, describeError(error))
    }
    const fresh = payouts.get(payout.id) as Payout
    if (fresh.status === 'confirmed') return checked
    const thymeRunning = checked.thymeStatus !== null && checked.thymeStatus !== 'failed' && checked.thymeStatus !== 'skipped'
    if (thymeRunning) return { ...checked, message: `${checked.message}. Not retried: Thyme may still send this transfer.` }
    if (fresh.status === 'submitted' && checked.thymeStatus === null) {
      return { ...checked, message: `${checked.message}. Not retried while the row is submitted: check the status or discard it first.` }
    }
  } else if (payout.status === 'submitted') {
    return actionResult(payout, 'Submitted without a Thyme execution id: discard it first, then retry')
  }

  const current = payouts.get(payout.id) as Payout
  // Handed to Thyme moments ago and the trigger is still awaiting its answer: re-arming now could send twice.
  if (current.status === 'pending' && current.submitted_at && !current.error && Date.now() - new Date(current.submitted_at).getTime() < THYME_WAIT_MS) {
    const seconds = Math.round((Date.now() - new Date(current.submitted_at).getTime()) / 1000)
    return actionResult(current, `Handed to Thyme ${seconds}s ago and still waiting for its answer; retry after ${Math.round(THYME_WAIT_MS / 1000)}s or check the status`)
  }
  const attempt = payouts.nextAttempt(invoice.id)
  let active: Payout
  if (current.status === 'pending') {
    active = payouts.update(current.id, { attempt, submitted_at: null, error: null, thyme_execution_id: null, tx_hash: null }) as Payout
  } else {
    active = payouts.create({
      invoice_id: current.invoice_id,
      beneficiary_id: current.beneficiary_id,
      amount_eurc: current.amount_eurc,
      amount_eur: current.amount_eur,
      currency: current.currency,
      fx_rate: current.fx_rate,
      cnb_rate: current.cnb_rate,
      cnb_valid_for: current.cnb_valid_for,
      amount_czk: current.amount_czk,
      executor: 'thyme',
      status: 'pending',
      attempt,
      override: current.override,
    })
  }
  invoices.setStatus(invoice.id, 'approved')
  appendAudit({
    actor: 'owner',
    event: 'payout.retried',
    invoiceId: invoice.id,
    beneficiaryId: current.beneficiary_id,
    details: { payout_id: active.id, previous_payout_id: current.id === active.id ? null : current.id, previous_status: current.status, attempt, previous_error: current.error },
  })
  // Hand it to the payment agent (respects the pause switch and the lock); the UI polls the row.
  void runPaymentsOnce()
  return actionResult(active, current.id === active.id ? `Re-armed as attempt ${attempt}; the payment agent sends it again` : `New payout queued as attempt ${attempt}`, { activePayoutId: active.id })
}

/** "Mark as failed / discard": settle a stuck pending or submitted payout as failed so the queue moves on. Idempotent. */
export async function discardPayout(payoutId: string, reason = 'Discarded by the owner'): Promise<PayoutActionResult> {
  const payout = payouts.get(payoutId)
  if (!payout) throw new Error(`payout ${payoutId} not found`)
  if (isSettled(payout)) return actionResult(payout, `Already ${payout.status}; nothing to discard`)
  const invoice = invoices.get(payout.invoice_id)
  if (!invoice) throw new Error(`invoice ${payout.invoice_id} not found`)
  appendAudit({ actor: 'owner', event: 'payout.discarded', invoiceId: invoice.id, beneficiaryId: payout.beneficiary_id, details: { payout_id: payout.id, previous_status: payout.status, execution_id: payout.thyme_execution_id, reason } })
  const settled = settle({ payout, invoice, status: 'failed', txHash: payout.tx_hash as Hex | null, blockNumber: payout.block_number, gasUsed: payout.gas_used, effectiveGasPriceWei: payout.effective_gas_price_wei, error: reason, simulated: payout.simulated === 1, actor: 'owner', thymeExecutionId: payout.thyme_execution_id ?? undefined })
  return actionResult(settled, 'Payout marked as failed; the invoice is failed and can be re-run or retried')
}

const lock = { busy: false }

/** Process every pending payout once (skipped while the payment agent is paused). Returns the number handled. */
export async function runPaymentsOnce(): Promise<number> {
  if (lock.busy) return 0
  lock.busy = true
  try {
    const { agents } = await import('../store/repos')
    const agent = agents.get('payment')
    if (agent && agent.status !== 'running') return 0
    const pending = payouts.listPending()
    let n = 0
    for (const p of pending) {
      await executeOnePayout(p.id)
      n += 1
    }
    if (n > 0) agents.touch('payment')
    return n
  } finally {
    lock.busy = false
  }
}

/**
 * "Force" demo path: what a fooled agent would do with a rejected invoice, i.e. try to pay the wallet printed
 * on the PDF. The payment rail refuses before Thyme: it only pays registered wallets within their limit.
 */
export async function forcePayout(invoiceId: string): Promise<Payout> {
  const invoice = invoices.get(invoiceId)
  if (!invoice) throw new Error('invoice not found')
  const to = addr(invoice.payee_wallet)
  if (!to) throw new Error('invoice has no wallet to pay')
  const amountEur = Math.round((invoice.amount_eur ?? invoice.amount ?? 0) * 100) / 100
  const { parseUnits } = await import('viem')
  const payout = payouts.create({
    invoice_id: invoice.id,
    beneficiary_id: invoice.beneficiary_id,
    amount_eurc: parseUnits(amountEur.toFixed(6), 6).toString(),
    amount_eur: amountEur,
    currency: invoice.currency ?? 'EUR',
    fx_rate: invoice.fx_rate ?? 1,
    executor: 'thyme',
    status: 'pending',
  })
  appendAudit({ actor: 'owner', event: 'payout.forced', invoiceId: invoice.id, beneficiaryId: invoice.beneficiary_id, details: { payout_id: payout.id, to, note: 'owner forced a rejected invoice; the payment rail decides' } })
  const before = invoice.status
  const settled = await executeOnePayout(payout.id, { force: true, to })
  // A rejected invoice stays rejected: the refusal is the point of the demo.
  if (before === 'rejected') invoices.setStatus(invoice.id, 'rejected')
  return settled
}
