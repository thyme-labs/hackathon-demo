import { type CheckContext, type CheckSpec, eur, makeResult } from './context'

const spec = { id: 'known_beneficiary', label: 'Known beneficiary', enforcement: 'agent', weight: 10 } as const

export const run = async (ctx: CheckContext) => {
  const b = ctx.beneficiary
  const source = 'beneficiary registry'
  if (!b) {
    const p = ctx.extracted.payee
    return makeResult(spec, ctx, {
      status: 'warn',
      evidence: `New payee: "${p.name}" (${ctx.payeeType.type}, ${p.country || 'country n/a'}, tax id ${p.tax_id ?? 'n/a'}) is not in the registry. Owner approval registers the wallet and a monthly limit.`,
      source,
      data: { matched: false, payee_type: ctx.payeeType.type, payee_type_source: ctx.payeeType.source },
    })
  }
  const history = `paid ${eur(b.total_paid_eur)} to date, trust ${b.trust_score}/100`
  if (b.status === 'blocked') {
    return makeResult(spec, ctx, {
      status: 'fail',
      evidence: `${b.name} is blocked by the owner. ${history}.`,
      source,
      data: { matched: true, matchedBy: ctx.matchedBy, status: b.status },
    })
  }
  if (b.status === 'paused' || b.status === 'new') {
    return makeResult(spec, ctx, {
      status: 'warn',
      evidence: `${b.name} matched by ${ctx.matchedBy} but is ${b.status}; owner must activate before payouts resume. ${history}.`,
      source,
      data: { matched: true, matchedBy: ctx.matchedBy, status: b.status },
    })
  }
  return makeResult(spec, ctx, {
    status: 'pass',
    evidence: `${b.name} (${b.type}, ${b.country ?? 'country n/a'}) matched by ${ctx.matchedBy}; active, ${history}${b.last_paid_at ? `, last paid ${b.last_paid_at.slice(0, 10)}` : ''}.`,
    source,
    data: { matched: true, matchedBy: ctx.matchedBy, status: b.status, beneficiaryId: b.id },
  })
}

export const knownBeneficiary: CheckSpec = { ...spec, run }
