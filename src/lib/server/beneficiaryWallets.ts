// Server-only: several wallets per beneficiary. Only an APPROVED wallet is ever paid; a wallet printed on an
// invoice of a known payee is recorded as 'pending' by the wallet_matches_file check and waits for the owner.
// Approving is an owner decision (audit owner.wallet_approved); it re-runs the checks of the invoices that were
// stopped on that wallet, so they get paid to it.
import { getAddress, isAddress } from 'viem'
import { appendAudit, beneficiaries, beneficiaryWallets, invoices, payouts } from '../store/repos'
import type { BeneficiaryWallet, Invoice } from '../store/types'

if (typeof window !== 'undefined') {
  throw new Error('src/lib/server/beneficiaryWallets.ts is server-only')
}

export interface WaitingInvoice {
  id: string
  number: string | null
  status: Invoice['status']
}

/** One wallet row as the Beneficiaries page shows it. */
export interface BeneficiaryWalletView extends BeneficiaryWallet {
  has_proof: boolean
  /** Confirmed EUR actually sent to this wallet (payouts.to_wallet). */
  paid_eur: number
  paid_count: number
  /** Stopped or held invoices printing this wallet; approving the wallet re-runs their checks. */
  waiting_invoices: WaitingInvoice[]
}

export interface ApproveWalletResult {
  wallet: BeneficiaryWalletView
  /** Invoices re-queued for the compliance agent. */
  rerun: WaitingInvoice[]
  /** Invoices that could not be re-run (already paid, payout in flight, ...). */
  skipped: { id: string; number: string | null; reason: string }[]
  message: string
}

const WAITING_STATUSES = new Set<Invoice['status']>(['rejected', 'needs_approval', 'failed'])

function normalize(wallet: string): string {
  if (!isAddress(wallet)) throw new Error('wallet is not a valid address')
  return getAddress(wallet).toLowerCase()
}

function waitingInvoicesFor(beneficiaryId: string, wallet: string): WaitingInvoice[] {
  return invoices
    .list({ beneficiaryId, limit: 500 })
    .filter((i) => i.payee_wallet?.toLowerCase() === wallet && WAITING_STATUSES.has(i.status))
    .filter((i) => !payouts.byInvoice(i.id).some((p) => p.status === 'confirmed'))
    .map((i) => ({ id: i.id, number: i.number, status: i.status }))
}

function toView(row: BeneficiaryWallet, totals = beneficiaryWallets.paidTotals(row.beneficiary_id)): BeneficiaryWalletView {
  const paid = totals[row.wallet] ?? { eur: 0, count: 0 }
  return {
    ...row,
    has_proof: Boolean(row.ownership_proof_json),
    paid_eur: paid.eur,
    paid_count: paid.count,
    waiting_invoices: row.status === 'approved' ? [] : waitingInvoicesFor(row.beneficiary_id, row.wallet),
  }
}

function requireWallet(walletId: string): BeneficiaryWallet {
  const row = beneficiaryWallets.get(walletId)
  if (!row) throw new Error('wallet not found')
  return row
}

/** Wallets of one beneficiary: primary first, then approved, pending, revoked. */
export function listWallets(beneficiaryId: string): BeneficiaryWalletView[] {
  const totals = beneficiaryWallets.paidTotals(beneficiaryId)
  return beneficiaryWallets.listByBeneficiary(beneficiaryId).map((row) => toView(row, totals))
}

/** Owner adds a wallet by hand: it starts as 'pending' and is approved in a second, explicit step. */
export function addWallet(input: { beneficiaryId: string; wallet: string; label?: string | null }): BeneficiaryWalletView {
  const beneficiary = beneficiaries.get(input.beneficiaryId)
  if (!beneficiary) throw new Error('beneficiary not found')
  const wallet = normalize(input.wallet)
  const label = input.label?.trim() || null
  const { wallet: row, created } = beneficiaryWallets.propose({ beneficiaryId: beneficiary.id, wallet, label, source: 'manual' })
  if (!created) {
    if (label && !row.label) beneficiaryWallets.update(row.id, { label })
    throw new Error(`${beneficiary.name} already has this wallet (${row.status})`)
  }
  appendAudit({ actor: 'owner', event: 'owner.wallet_added', beneficiaryId: beneficiary.id, details: { wallet_id: row.id, wallet, label, status: row.status, source: 'manual' } })
  return toView(beneficiaryWallets.get(row.id) as BeneficiaryWallet)
}

/**
 * Owner approves a wallet: from now on invoices printing it are paid to it. Invoices that were stopped on this
 * wallet are re-run through the checks (retryInvoice); the trust score is untouched, the audit entry records
 * whether the wallet arrived via an invoice and whether an ownership proof exists.
 */
export async function approveWallet(input: { walletId: string; approvedBy?: string }): Promise<ApproveWalletResult> {
  const before = requireWallet(input.walletId)
  const beneficiary = beneficiaries.get(before.beneficiary_id)
  if (!beneficiary) throw new Error('beneficiary not found')
  if (before.status === 'revoked') throw new Error('a revoked wallet cannot be approved again; add it as a new wallet')
  const waiting = before.status === 'approved' ? [] : waitingInvoicesFor(before.beneficiary_id, before.wallet)
  const row = beneficiaryWallets.approve(before.id, input.approvedBy ?? 'owner') as BeneficiaryWallet
  appendAudit({
    actor: 'owner',
    event: 'owner.wallet_approved',
    beneficiaryId: beneficiary.id,
    details: {
      wallet_id: row.id,
      wallet: row.wallet,
      label: row.label,
      source: row.source,
      arrived_via_invoice: row.source === 'invoice',
      has_ownership_proof: Boolean(row.ownership_proof_json),
      is_primary: row.is_primary === 1,
      already_approved: before.status === 'approved',
      trust_score: beneficiary.trust_score,
      trust_score_changed: false,
      rerun_invoices: waiting.map((i) => i.id),
      note: 'owner decision: a wallet that arrived on an invoice without an ownership proof is approved on the owner\'s word',
    },
  })
  const rerun: WaitingInvoice[] = []
  const skipped: ApproveWalletResult['skipped'] = []
  if (waiting.length > 0) {
    const { retryInvoice } = await import('./invoices.fns')
    for (const inv of waiting) {
      try {
        await retryInvoice({ data: { id: inv.id } })
        rerun.push(inv)
      } catch (error) {
        skipped.push({ id: inv.id, number: inv.number, reason: error instanceof Error ? error.message : String(error) })
      }
    }
  }
  const view = toView(beneficiaryWallets.get(row.id) as BeneficiaryWallet)
  const label = `${row.wallet.slice(0, 6)}…${row.wallet.slice(-4)}`
  const message =
    before.status === 'approved'
      ? `${label} was already approved`
      : rerun.length > 0
        ? `${label} approved for ${beneficiary.name}; re-running the checks of ${rerun.map((i) => i.number ?? i.id.slice(0, 8)).join(', ')}`
        : `${label} approved for ${beneficiary.name}`
  return { wallet: view, rerun, skipped, message }
}

/** Owner revokes a wallet: never paid again. A revoked primary hands the primary role to the next approved wallet. */
export function revokeWallet(input: { walletId: string; reason?: string | null }): BeneficiaryWalletView {
  const before = requireWallet(input.walletId)
  const row = beneficiaryWallets.revoke(before.id) as BeneficiaryWallet
  const after = beneficiaries.get(row.beneficiary_id)
  appendAudit({
    actor: 'owner',
    event: 'owner.wallet_revoked',
    beneficiaryId: row.beneficiary_id,
    details: { wallet_id: row.id, wallet: row.wallet, label: row.label, previous_status: before.status, was_primary: before.is_primary === 1, new_primary: after?.wallet ?? null, reason: input.reason ?? null },
  })
  return toView(row)
}

/** Owner picks the primary wallet (the default recipient when an invoice prints none). Must be approved. */
export function setPrimary(input: { walletId: string }): BeneficiaryWalletView {
  const before = requireWallet(input.walletId)
  const row = beneficiaryWallets.setPrimary(before.id) as BeneficiaryWallet
  appendAudit({ actor: 'owner', event: 'owner.wallet_primary_set', beneficiaryId: row.beneficiary_id, details: { wallet_id: row.id, wallet: row.wallet, label: row.label } })
  return toView(row)
}

/**
 * Invoice action card helper: approve the pending wallet printed on an invoice of a known payee (the one the
 * wallet_matches_file check recorded) and re-run that invoice. Throws when the invoice has no beneficiary, prints
 * no wallet, or the wallet is not pending.
 */
export async function approvePendingWalletForInvoice(invoiceId: string, approvedBy = 'owner'): Promise<ApproveWalletResult> {
  const invoice = invoices.get(invoiceId)
  if (!invoice) throw new Error('invoice not found')
  if (!invoice.beneficiary_id) throw new Error('the invoice is not matched to a registered beneficiary; register the payee instead')
  if (!invoice.payee_wallet) throw new Error('the invoice prints no wallet')
  const wallet = invoice.payee_wallet.toLowerCase()
  const existing = beneficiaryWallets.find(invoice.beneficiary_id, wallet) ?? beneficiaryWallets.propose({ beneficiaryId: invoice.beneficiary_id, wallet, label: `printed on invoice ${invoice.number ?? invoice.id.slice(0, 8)}`, source: 'invoice' }).wallet
  if (existing.status === 'approved') throw new Error('this wallet is already approved; re-run the checks')
  if (existing.status === 'revoked') throw new Error('this wallet was revoked by the owner; it is never paid again')
  return approveWallet({ walletId: existing.id, approvedBy })
}
