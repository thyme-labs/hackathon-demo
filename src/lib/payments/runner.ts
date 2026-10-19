// Server-only payment agent: turns `pending` payouts into EURC transfers.
//   thyme     -> hands the payout to Thyme Flow (the executable's run-only webhook) and waits for the
//                result; Thyme executes EURC.transfer through the Roles profile on the user's own Safe.
//                The app holds no key. The task's callbacks (/api/webhooks/thyme) are the fast path.
//   simulated -> Thyme not configured / onboarding simulated: the payout is recorded as `simulated`
//                with a labelled placeholder hash so the whole flow still runs in mock mode.
import { type Address, getAddress, type Hex, isAddress, keccak256, toHex } from 'viem'
import { type PaymentExecutorName, serverEnv } from '../env'
import { appendAudit, beneficiaries, invoices, nowIso, payouts, settings } from '../store/repos'
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
 * Agent-side rules the rail enforces before anything reaches Thyme: the recipient must be the wallet on
 * file of an active beneficiary and the amount must fit the 30-day limit. The chain does not know these;
 * Thyme's Roles scope only guarantees EURC.transfer from this Safe.
 */
function agentRefusal(payout: Payout, to: Address, onFile: Address | null, beneficiary: ReturnType<typeof beneficiaries.get>): string | null {
  if (!beneficiary) return `no registered beneficiary for this payout; the rail only pays wallets on file (agent rule)`
  if (!onFile) return `${beneficiary.name} has no wallet on file (agent rule)`
  if (onFile.toLowerCase() !== to.toLowerCase()) {
    return `${to} is not the wallet on file for ${beneficiary.name} (${onFile}). Thyme only ever receives registered wallets from /api/thyme/pending, so even a fooled agent cannot pay it (agent rule). On chain, Thyme's Roles scope allows nothing but EURC.transfer from this Safe (chain rule).`
  }
  if (beneficiary.status !== 'active') return `${beneficiary.name} is ${beneficiary.status}; only active beneficiaries are paid (agent rule)`
  const spent = spentLast30Days(beneficiary.id, payout.id)
  if (spent + payout.amount_eur > beneficiary.monthly_limit_eur + 0.005) {
    return `€${payout.amount_eur.toFixed(2)} exceeds the remaining 30-day limit of ${beneficiary.name}: €${(beneficiary.monthly_limit_eur - spent).toFixed(2)} of €${beneficiary.monthly_limit_eur.toFixed(2)} left (agent rule)`
  }
  return null
}

/** Execute one pending payout to the beneficiary wallet ON FILE. Returns the settled (or still in-flight) row. */
export async function executeOnePayout(payoutId: string, opts: { force?: boolean; to?: Address } = {}): Promise<Payout> {
  const payout = payouts.get(payoutId)
  if (!payout) throw new Error(`payout ${payoutId} not found`)
  if (payout.status !== 'pending') return payout
  const invoice = invoices.get(payout.invoice_id)
  if (!invoice) throw new Error(`invoice ${payout.invoice_id} not found`)
  const beneficiary = payout.beneficiary_id ? beneficiaries.get(payout.beneficiary_id) : null
  const onFile = addr(beneficiary?.wallet)
  const to = opts.to ?? onFile
  if (!to) {
    return settle({ payout, invoice, status: 'failed', txHash: null, blockNumber: null, gasUsed: null, effectiveGasPriceWei: null, error: 'beneficiary has no wallet on file', simulated: false, actor: 'agent' })
  }

  const { mode, reason } = await resolveExecutionMode()
  const ts = nowIso()

  const refusal = agentRefusal(payout, to, onFile, beneficiary)
  if (refusal) {
    appendAudit({ actor: 'agent', event: 'payout.refused', invoiceId: invoice.id, beneficiaryId: payout.beneficiary_id, details: { payout_id: payout.id, to, amount_eurc: payout.amount_eurc, mode, force: opts.force ?? false, reason: refusal } })
    await sleep(REFUSAL_DELAY_MS)
    return settle({ payout, invoice, status: 'failed', txHash: null, blockNumber: null, gasUsed: null, effectiveGasPriceWei: null, error: `Payment agent refused: ${refusal}`, simulated: mode === 'simulated', actor: 'agent' })
  }

  if (mode === 'simulated') {
    payouts.setStatus(payout.id, 'submitted', { submitted_at: ts })
    invoices.setStatus(invoice.id, 'paying')
    appendAudit({ actor: 'agent', event: 'payout.submitted', invoiceId: invoice.id, beneficiaryId: payout.beneficiary_id, details: { payout_id: payout.id, to, amount_eurc: payout.amount_eurc, mode, reason, force: opts.force ?? false } })
    const submitted = payouts.get(payout.id) as Payout
    await sleep(SIMULATED_DELAY_MS)
    return settle({ payout: submitted, invoice, status: 'confirmed', txHash: simulatedTxHash(payout.id), blockNumber: null, gasUsed: SIMULATED_GAS_USED, effectiveGasPriceWei: null, error: null, simulated: true })
  }

  // Hand the payout to Thyme. The row stays `pending` because the task pulls pending rows from
  // /api/thyme/pending; submitted_at marks the hand-over so the next tick does not trigger it again.
  payouts.update(payout.id, { submitted_at: ts, error: null })
  invoices.setStatus(invoice.id, 'paying')
  appendAudit({ actor: 'agent', event: 'payout.submitted', invoiceId: invoice.id, beneficiaryId: payout.beneficiary_id, details: { payout_id: payout.id, to, amount_eurc: payout.amount_eurc, mode, reason, force: opts.force ?? false } })

  const ids = readThymeIds()
  const { executePayout } = await import('../thyme/executor')
  const { getThymeEnv } = await import('../thyme/env')
  const env = getThymeEnv()
  try {
    const result = await executePayout(
      { payoutId: payout.id, invoiceId: invoice.id, payee: to, amountEurcUnits: BigInt(payout.amount_eurc) },
      { webhookUrl: ids.webhookUrl ?? undefined, safeAddress: readSafeAddress() ?? undefined, appUrl: env.appUrl, pullToken: env.pullToken, timeoutMs: THYME_WAIT_MS },
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
