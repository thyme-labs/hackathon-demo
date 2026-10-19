import { type CheckContext, type CheckSpec, eur, makeResult } from './context'

const spec = { id: 'budget', label: 'Within monthly limit', enforcement: 'agent', weight: 10 } as const

const EURC_DECIMALS = 6

export const run = async (ctx: CheckContext) => {
  const b = ctx.beneficiary
  const source = 'beneficiary limit + payouts (30-day rolling); enforced again by the payment agent before Thyme is called'
  if (!b) {
    return makeResult(spec, ctx, { status: 'skip', evidence: 'No beneficiary yet; the owner sets the monthly limit when approving.', source })
  }
  const amountEur = ctx.out.amountEur ?? (ctx.extracted.invoice.currency === 'EUR' ? ctx.extracted.invoice.gross : null)
  if (amountEur === null) {
    return makeResult(spec, ctx, { status: 'fail', evidence: 'Amount in EUR unknown (FX failed); cannot test the limit.', source })
  }
  const since = new Date(ctx.now.getTime() - 30 * 86_400_000).toISOString()
  const spent = ctx.store
    .listPayoutsSince(b.id, since)
    .filter((p) => p.status === 'pending' || p.status === 'submitted' || p.status === 'confirmed')
    .reduce((s, p) => s + p.amount_eur, 0)
  const remainingOffChain = Math.round((b.monthly_limit_eur - spent) * 100) / 100
  let onChain: { remaining: number; period: number } | null = null
  if (ctx.deps.readAllowance) {
    try {
      const snap = await ctx.deps.readAllowance(b)
      if (snap) onChain = { remaining: Number(snap.balance) / 10 ** EURC_DECIMALS, period: snap.period }
    } catch {
      onChain = null
    }
  }
  const data = { amountEur, limit: b.monthly_limit_eur, spent30d: spent, remainingOffChain, onChain }
  const chainNote = onChain ? `; on-chain allowance remaining ${eur(onChain.remaining)} (Roles, ${onChain.period ? `${Math.round(onChain.period / 86_400)}-day refill` : 'one-off'})` : ''
  if (amountEur > remainingOffChain) {
    return makeResult(spec, ctx, {
      status: 'fail',
      evidence: `${eur(amountEur)} exceeds the remaining limit ${eur(remainingOffChain)} (limit ${eur(b.monthly_limit_eur)}/30d, ${eur(spent)} paid)${chainNote}. The payment agent will not hand this transfer to Thyme.`,
      source,
      data,
    })
  }
  if (onChain && amountEur > onChain.remaining) {
    return makeResult(spec, ctx, {
      status: 'fail',
      evidence: `${eur(amountEur)} exceeds the on-chain allowance ${eur(onChain.remaining)} even though the ledger shows ${eur(remainingOffChain)} left; the payment agent will not hand it to Thyme.`,
      source,
      data,
    })
  }
  return makeResult(spec, ctx, {
    status: 'pass',
    evidence: `${eur(amountEur)} within limit: ${eur(remainingOffChain)} of ${eur(b.monthly_limit_eur)} left after ${eur(spent)} in the last 30 days${chainNote}.`,
    source,
    data,
  })
}

export const budget: CheckSpec = { ...spec, run }
