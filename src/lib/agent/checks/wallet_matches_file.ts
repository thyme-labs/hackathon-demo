// Check 1: the wallet printed on the invoice must be one of the beneficiary's APPROVED wallets.
// A known payee printing an unknown wallet is the invoice-redirection (BEC) pattern: the check fails
// (critical) and records the wallet as 'pending' so the owner can approve it explicitly on the
// Beneficiaries page; nothing is paid to it before that.
import { approvedWallets, type CheckContext, type CheckSpec, makeResult, shortAddr } from './context'

const spec = { id: 'wallet_matches_file', label: 'Wallet matches file', enforcement: 'agent', weight: 15 } as const

const day = (iso: string | null | undefined): string => (iso ? iso.slice(0, 10) : 'n/a')

const describeApproved = (list: ReturnType<typeof approvedWallets>): string =>
  list.map((w) => `${shortAddr(w.wallet)}${w.isPrimary ? ' (primary)' : w.label ? ` ("${w.label}")` : ''}`).join(', ')

export const run = async (ctx: CheckContext) => {
  const printed = ctx.extracted.payment.wallet
  const iban = ctx.extracted.payment.iban
  const source = 'beneficiary registry (approved wallets) vs. extracted invoice'
  if (!ctx.beneficiary) {
    if (!printed) {
      return makeResult(spec, ctx, {
        status: 'warn',
        evidence: 'No wallet printed on the invoice and no registry entry; the owner must enter the wallet by hand.',
        source,
        data: { printed: null, onFile: null },
      })
    }
    return makeResult(spec, ctx, {
      status: 'skip',
      evidence: `No registry entry yet. The printed wallet ${shortAddr(printed)} is proposed for registration and becomes the only allowed recipient once the owner signs.`,
      source,
      data: { printed, onFile: null },
    })
  }
  const b = ctx.beneficiary
  const approved = approvedWallets(ctx)
  const primary = approved.find((w) => w.isPrimary) ?? approved[0] ?? null
  const onFile = primary?.wallet ?? null
  const approvedList = approved.map((w) => w.wallet)
  if (!onFile) {
    return makeResult(spec, ctx, {
      status: 'warn',
      evidence: `${b.name} has no approved wallet on file${printed ? `; invoice prints ${shortAddr(printed)}` : ''}. Owner must approve a wallet before any payout.`,
      source,
      data: { printed, onFile: null, approved: [] },
    })
  }
  if (!printed) {
    return makeResult(spec, ctx, {
      status: 'warn',
      evidence: `Invoice prints no wallet${iban ? ` (it prints IBAN ${iban})` : ''}. Payout would go to the primary wallet on file ${shortAddr(onFile)}; owner should confirm.`,
      source,
      data: { printed: null, onFile, approved: approvedList },
    })
  }
  const hit = approved.find((w) => w.wallet === printed)
  if (hit) {
    const count = `${approved.length} approved wallet${approved.length === 1 ? '' : 's'}`
    const evidence = hit.isPrimary
      ? `Printed wallet ${shortAddr(printed)} is ${b.name}'s primary approved wallet (${count} on file)${iban ? `; an IBAN is also printed (${iban}), ignored` : ''}.`
      : `Printed wallet ${shortAddr(printed)} is an approved secondary wallet of ${b.name}${hit.label ? ` ("${hit.label}")` : ''}, approved ${day(hit.approvedAt)} by the owner; the payout goes to it, not to the primary ${shortAddr(onFile)}.`
    return makeResult(spec, ctx, {
      status: 'pass',
      evidence,
      source,
      data: { printed, onFile, approved: approvedList, mismatch: false, paidTo: printed, primary: hit.isPrimary, label: hit.label, hasProof: hit.hasProof },
    })
  }
  const known = ctx.wallets.find((w) => w.wallet.toLowerCase() === printed)
  if (known?.status === 'revoked') {
    return makeResult(spec, ctx, {
      status: 'fail',
      evidence: `Invoice prints ${printed}, a wallet of ${b.name} the owner revoked${known.label ? ` ("${known.label}")` : ''}; approved wallets on file: ${describeApproved(approved)}. A revoked wallet is never paid again; payment stopped (agent rule).`,
      source,
      data: { printed, onFile, approved: approvedList, mismatch: true, walletStatus: 'revoked', walletId: known.id },
    })
  }
  const bec = 'Pattern of swapped-wallet (BEC) invoice fraud; payment stopped. The payment rail only ever hands Thyme an approved wallet, so the printed address cannot be paid even if an agent were fooled (agent rule).'
  if (known?.status === 'pending') {
    return makeResult(spec, ctx, {
      status: 'fail',
      evidence: `Invoice prints ${printed}, which is not an approved wallet of ${b.name} (approved: ${describeApproved(approved)}). A new wallet for a known payee needs owner approval: this one has been pending since ${day(known.created_at)} (source: ${known.source}) and nothing is paid to it until the owner approves it on the Beneficiaries page. ${bec}`,
      source,
      data: { printed, onFile, approved: approvedList, mismatch: true, walletStatus: 'pending', walletId: known.id, needsOwnerApproval: true },
    })
  }
  // Unknown wallet for a known payee: record it as pending so the owner can approve it explicitly.
  let walletId: string | null = null
  const proposed = ctx.store.proposeBeneficiaryWallet?.({ beneficiaryId: b.id, wallet: printed, label: `printed on invoice ${ctx.extracted.invoice.number}` })
  if (proposed) {
    walletId = proposed.wallet.id
    if (proposed.created) {
      ctx.store.appendAudit({
        actor: 'agent',
        invoice_id: ctx.invoice.id,
        beneficiary_id: b.id,
        event: 'wallet.proposed',
        details: { wallet_id: walletId, wallet: printed, source: 'invoice', status: 'pending', note: 'new wallet for a known payee needs owner approval' },
      })
    }
  }
  return makeResult(spec, ctx, {
    status: 'fail',
    evidence: `Invoice prints ${printed} but ${b.name}'s approved wallet${approved.length === 1 ? ' on file is' : 's on file are'} ${describeApproved(approved)}. A new wallet for a known payee needs owner approval: it is recorded as a pending wallet (source: this invoice) on the Beneficiaries page and nothing is paid to it until the owner approves it explicitly. ${bec}`,
    source,
    data: { printed, onFile, approved: approvedList, mismatch: true, walletStatus: 'pending', walletId, needsOwnerApproval: true },
  })
}

export const walletMatchesFile: CheckSpec = { ...spec, run }
