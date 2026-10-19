import { type CheckContext, type CheckSpec, makeResult, shortAddr } from './context'

const spec = { id: 'wallet_matches_file', label: 'Wallet matches file', enforcement: 'agent', weight: 15 } as const

export const run = async (ctx: CheckContext) => {
  const printed = ctx.extracted.payment.wallet
  const iban = ctx.extracted.payment.iban
  const source = 'beneficiary registry vs. extracted invoice'
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
  const onFile = ctx.beneficiary.wallet?.toLowerCase() ?? null
  if (!onFile) {
    return makeResult(spec, ctx, {
      status: 'warn',
      evidence: `${ctx.beneficiary.name} has no wallet on file${printed ? `; invoice prints ${shortAddr(printed)}` : ''}. Owner must set the wallet before any payout.`,
      source,
      data: { printed, onFile: null },
    })
  }
  if (!printed) {
    return makeResult(spec, ctx, {
      status: 'warn',
      evidence: `Invoice prints no wallet${iban ? ` (it prints IBAN ${iban})` : ''}. Payout would go to the wallet on file ${shortAddr(onFile)}; owner should confirm.`,
      source,
      data: { printed: null, onFile },
    })
  }
  if (printed !== onFile) {
    return makeResult(spec, ctx, {
      status: 'fail',
      evidence: `Invoice prints ${printed} but the wallet on file is ${onFile}. Pattern of swapped-wallet invoice fraud; payment stopped. The payment rail only ever hands Thyme the wallet on file, so the printed address cannot be paid even if an agent were fooled (agent rule).`,
      source,
      data: { printed, onFile, mismatch: true },
    })
  }
  return makeResult(spec, ctx, {
    status: 'pass',
    evidence: `Printed wallet ${shortAddr(printed)} equals the wallet on file${iban ? `; an IBAN is also printed (${iban}), ignored` : ''}.`,
    source,
    data: { printed, onFile, mismatch: false },
  })
}

export const walletMatchesFile: CheckSpec = { ...spec, run }
