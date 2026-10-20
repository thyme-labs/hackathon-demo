import { createServerFn } from '@tanstack/react-start'
import { tenantMiddleware } from './tenantMiddleware'
import type { Beneficiary } from '../store/types'
import type { ApproveWalletResult, BeneficiaryWalletView } from './beneficiaryWallets'
import type { BeneficiaryDetail, BeneficiaryListItem } from './dto'

/** BeneficiaryDetail plus the wallet rows (beneficiary_wallets): primary first, then approved, pending, revoked. */
export interface BeneficiaryDetailWithWallets extends BeneficiaryDetail {
  wallets: BeneficiaryWalletView[]
}

export const listBeneficiaries = createServerFn({ method: 'GET' }).middleware([tenantMiddleware]).handler(async (): Promise<BeneficiaryListItem[]> => {
  const { beneficiaries, payouts, invoices } = await import('../store/repos')
  const paid = payouts.paidThisMonthByBeneficiary()
  const counts = new Map<string, number>()
  for (const i of invoices.list({ limit: 1000 })) {
    if (i.beneficiary_id) counts.set(i.beneficiary_id, (counts.get(i.beneficiary_id) ?? 0) + 1)
  }
  return beneficiaries.list().map((b) => ({ ...b, paid_this_month_eur: paid[b.id] ?? 0, invoice_count: counts.get(b.id) ?? 0 }))
})

export const getBeneficiary = createServerFn({ method: 'GET', strict: false }).middleware([tenantMiddleware])
  .validator((input: { id: string }) => input)
  .handler(async ({ data }): Promise<BeneficiaryDetailWithWallets | null> => {
    const { beneficiaries, payouts, invoices } = await import('../store/repos')
    const { parseChecklist } = await import('../agent/checklist')
    const { listWallets } = await import('./beneficiaryWallets')
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
      wallets: listWallets(b.id),
    }
  })

export const setBeneficiaryStatus = createServerFn({ method: 'POST' }).middleware([tenantMiddleware])
  .validator((input: { id: string; status: Beneficiary['status'] }) => input)
  .handler(async ({ data }): Promise<Beneficiary> => {
    const { beneficiaries, appendAudit } = await import('../store/repos')
    const before = beneficiaries.get(data.id)
    if (!before) throw new Error('beneficiary not found')
    const after = beneficiaries.update(data.id, { status: data.status }) as Beneficiary
    appendAudit({ actor: 'owner', event: `beneficiary.${data.status}`, beneficiaryId: data.id, details: { from: before.status, to: data.status } })
    return after
  })

// ── Wallets (several per beneficiary; only approved ones are ever paid) ──────────────────────────

export const listBeneficiaryWallets = createServerFn({ method: 'GET', strict: false }).middleware([tenantMiddleware])
  .validator((input: { beneficiaryId: string }) => input)
  .handler(async ({ data }): Promise<BeneficiaryWalletView[]> => {
    const { listWallets } = await import('./beneficiaryWallets')
    return listWallets(data.beneficiaryId)
  })

/** Adds a wallet as 'pending'; the owner approves it in a second, explicit step. */
export const addBeneficiaryWallet = createServerFn({ method: 'POST' }).middleware([tenantMiddleware])
  .validator((input: { beneficiaryId: string; wallet: string; label?: string | null }) => input)
  .handler(async ({ data }): Promise<BeneficiaryWalletView> => {
    const { addWallet } = await import('./beneficiaryWallets')
    return addWallet(data)
  })

/** Owner action (audit owner.wallet_approved): the wallet may be paid; invoices stopped on it are re-run. */
export const approveBeneficiaryWallet = createServerFn({ method: 'POST' }).middleware([tenantMiddleware])
  .validator((input: { walletId: string }) => input)
  .handler(async ({ data }): Promise<ApproveWalletResult> => {
    const { approveWallet } = await import('./beneficiaryWallets')
    return approveWallet({ walletId: data.walletId, approvedBy: 'owner' })
  })

export const revokeBeneficiaryWallet = createServerFn({ method: 'POST' }).middleware([tenantMiddleware])
  .validator((input: { walletId: string; reason?: string | null }) => input)
  .handler(async ({ data }): Promise<BeneficiaryWalletView> => {
    const { revokeWallet } = await import('./beneficiaryWallets')
    return revokeWallet(data)
  })

export const setPrimaryBeneficiaryWallet = createServerFn({ method: 'POST' }).middleware([tenantMiddleware])
  .validator((input: { walletId: string }) => input)
  .handler(async ({ data }): Promise<BeneficiaryWalletView> => {
    const { setPrimary } = await import('./beneficiaryWallets')
    return setPrimary(data)
  })

/** Invoice action card: approve the pending wallet printed on this invoice and re-run its checks. */
export const approveInvoiceWallet = createServerFn({ method: 'POST' }).middleware([tenantMiddleware])
  .validator((input: { invoiceId: string }) => input)
  .handler(async ({ data }): Promise<ApproveWalletResult> => {
    const { approvePendingWalletForInvoice } = await import('./beneficiaryWallets')
    return approvePendingWalletForInvoice(data.invoiceId, 'owner')
  })
