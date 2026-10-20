import { createServerFn } from '@tanstack/react-start'
import { tenantMiddleware } from './tenantMiddleware'
import type { PayoutActionResult, PayoutListItem } from './dto'

export const listPayouts = createServerFn({ method: 'GET' }).middleware([tenantMiddleware]).handler(async (): Promise<PayoutListItem[]> => {
  const { payouts, invoices, beneficiaries } = await import('../store/repos')
  const { isPayoutStuck } = await import('../payments/runner')
  const inv = new Map(invoices.list({ limit: 1000 }).map((i) => [i.id, i]))
  const ben = new Map(beneficiaries.list().map((b) => [b.id, b]))
  const now = Date.now()
  return payouts.list({ limit: 500 }).map((p) => {
    const b = p.beneficiary_id ? ben.get(p.beneficiary_id) : undefined
    return {
      ...p,
      invoice_number: inv.get(p.invoice_id)?.number ?? null,
      beneficiary_name: b?.name ?? inv.get(p.invoice_id)?.payee_name ?? null,
      beneficiary_country: b?.country ?? null,
      to_wallet: p.to_wallet ?? b?.wallet ?? inv.get(p.invoice_id)?.payee_wallet ?? null,
      stuck: isPayoutStuck(p, now),
    }
  })
})

/**
 * Retry a failed / reverted / stuck payout: Thyme is re-triggered with a NEW Idempotency-Key suffix (next
 * attempt). A row Thyme still reports as running is left alone. Idempotent: a second click reports the in-flight row.
 */
export const retryPayout = createServerFn({ method: 'POST' }).middleware([tenantMiddleware])
  .validator((input: { payoutId: string }) => input)
  .handler(async ({ data }): Promise<PayoutActionResult> => {
    const { retryPayout: run } = await import('../payments/runner')
    return run(data.payoutId)
  })

/** Re-read the Thyme execution recorded on the payout and settle the row when Thyme has a terminal answer. */
export const checkPayoutStatus = createServerFn({ method: 'POST' }).middleware([tenantMiddleware])
  .validator((input: { payoutId: string }) => input)
  .handler(async ({ data }): Promise<PayoutActionResult> => {
    const { reconcilePayout } = await import('../payments/runner')
    return reconcilePayout(data.payoutId)
  })

/** Mark a stuck pending / submitted payout as failed so the invoice can be re-run or retried. Idempotent. */
export const discardPayout = createServerFn({ method: 'POST' }).middleware([tenantMiddleware])
  .validator((input: { payoutId: string }) => input)
  .handler(async ({ data }): Promise<PayoutActionResult> => {
    const { discardPayout: run } = await import('../payments/runner')
    return run(data.payoutId)
  })
