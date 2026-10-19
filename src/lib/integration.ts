// Hooks from the API routes into the agent pipeline and the payment agent.
import { appendAudit } from '@/lib/store/repos'

/** Called right after an uploaded PDF is stored and the invoice row is inserted with status 'queued'. */
export async function onInvoiceQueued(invoiceId: string): Promise<void> {
  const { ensureBooted } = await import('@/lib/server/boot')
  ensureBooted()
  const { agents } = await import('@/lib/store/repos')
  const compliance = agents.get('compliance')
  if (compliance && compliance.status !== 'running') {
    appendAudit({ actor: 'agent', event: 'investigation.held', invoiceId, details: { reason: 'compliance agent paused' } })
    return
  }
  // Go through the worker lock (oldest queued first) so the interval tick never investigates the same
  // invoice twice. When the lock is busy the tick picks this invoice up within a few seconds.
  const { runQueueOnce } = await import('@/lib/agent/service')
  const result = await runQueueOnce()
  if (result) agents.touch('compliance')
  const { runPaymentsOnce } = await import('@/lib/payments/runner')
  await runPaymentsOnce()
}

/** Called after POST /api/webhooks/thyme updated a payout. */
export async function onPayoutCallback(payoutId: string): Promise<void> {
  const { payouts, appendAudit: audit } = await import('@/lib/store/repos')
  const payout = payouts.get(payoutId)
  if (!payout) return
  audit({ actor: 'thyme', event: 'payout.callback_processed', invoiceId: payout.invoice_id, beneficiaryId: payout.beneficiary_id, details: { payout_id: payoutId, status: payout.status } })
}
