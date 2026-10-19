import { createServerFn } from '@tanstack/react-start'
import type { PayoutListItem } from './dto'

export const listPayouts = createServerFn({ method: 'GET' }).handler(async (): Promise<PayoutListItem[]> => {
  const { payouts, invoices, beneficiaries } = await import('../store/repos')
  const inv = new Map(invoices.list({ limit: 1000 }).map((i) => [i.id, i]))
  const ben = new Map(beneficiaries.list().map((b) => [b.id, b]))
  return payouts.list({ limit: 500 }).map((p) => {
    const b = p.beneficiary_id ? ben.get(p.beneficiary_id) : undefined
    return {
      ...p,
      invoice_number: inv.get(p.invoice_id)?.number ?? null,
      beneficiary_name: b?.name ?? inv.get(p.invoice_id)?.payee_name ?? null,
      beneficiary_country: b?.country ?? null,
      to_wallet: b?.wallet ?? inv.get(p.invoice_id)?.payee_wallet ?? null,
    }
  })
})
