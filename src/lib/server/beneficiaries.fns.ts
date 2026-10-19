import { createServerFn } from '@tanstack/react-start'
import type { Beneficiary } from '../store/types'
import type { BeneficiaryDetail, BeneficiaryListItem } from './dto'

export const listBeneficiaries = createServerFn({ method: 'GET' }).handler(async (): Promise<BeneficiaryListItem[]> => {
  const { beneficiaries, payouts, invoices } = await import('../store/repos')
  const paid = payouts.paidThisMonthByBeneficiary()
  const counts = new Map<string, number>()
  for (const i of invoices.list({ limit: 1000 })) {
    if (i.beneficiary_id) counts.set(i.beneficiary_id, (counts.get(i.beneficiary_id) ?? 0) + 1)
  }
  return beneficiaries.list().map((b) => ({ ...b, paid_this_month_eur: paid[b.id] ?? 0, invoice_count: counts.get(b.id) ?? 0 }))
})

export const getBeneficiary = createServerFn({ method: 'GET', strict: false })
  .validator((input: { id: string }) => input)
  .handler(async ({ data }): Promise<BeneficiaryDetail | null> => {
    const { beneficiaries, payouts, invoices } = await import('../store/repos')
    const { parseChecklist } = await import('../agent/checklist')
    const b = beneficiaries.get(data.id)
    if (!b) return null
    const rows = invoices.list({ beneficiaryId: b.id, limit: 100 })
    const latest = rows.find((i) => i.checklist_json)
    return {
      beneficiary: b,
      invoices: rows.map((i) => ({
        id: i.id,
        number: i.number,
        payee_name: i.payee_name,
        beneficiary_name: b.name,
        currency: i.currency,
        amount: i.amount,
        amount_eur: i.amount_eur,
        status: i.status,
        score: i.score,
        created_at: i.created_at,
        updated_at: i.updated_at,
      })),
      payouts: payouts.list({ limit: 500 }).filter((p) => p.beneficiary_id === b.id),
      lastChecklist: latest ? parseChecklist(latest.checklist_json) : null,
      paid_this_month_eur: beneficiaries.paidThisMonthEur(b.id),
    }
  })

export const setBeneficiaryStatus = createServerFn({ method: 'POST' })
  .validator((input: { id: string; status: Beneficiary['status'] }) => input)
  .handler(async ({ data }): Promise<Beneficiary> => {
    const { beneficiaries, appendAudit } = await import('../store/repos')
    const before = beneficiaries.get(data.id)
    if (!before) throw new Error('beneficiary not found')
    const after = beneficiaries.update(data.id, { status: data.status }) as Beneficiary
    appendAudit({ actor: 'owner', event: `beneficiary.${data.status}`, beneficiaryId: data.id, details: { from: before.status, to: data.status } })
    return after
  })
