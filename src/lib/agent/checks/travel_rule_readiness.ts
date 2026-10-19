// Will the payee's exchange accept this transfer without bouncing it? Reg. (EU) 2023/1113 (Transfer of Funds
// Regulation) Art. 14(5) and 16(2): above EUR 1,000 to or from a self-hosted wallet the CASP verifies ownership
// and needs originator and beneficiary records. The company is the originator but not a CASP; this check measures
// the readiness of the data the payee's off-ramp will demand, not an obligation of ours. Static rules, no network.
import originator from '../../../../config/originator.json'
import rails from '../../../../config/rails.json'
import { parseOwnershipProof } from '../ownership'
import { type CheckContext, type CheckSpec, eur, makeResult } from './context'

const spec = { id: 'travel_rule_readiness', label: 'Travel Rule record', enforcement: 'agent', weight: 4 } as const

const THRESHOLD_EUR: number = rails.eurc.travel_rule.self_hosted_threshold_eur
const SOURCE = `Reg. (EU) 2023/1113 Art. 14(5)/16(2); config/originator.json; config/rails.json travel_rule (threshold EUR ${THRESHOLD_EUR.toLocaleString('en-GB')})`

const present = (v: string | null | undefined): boolean => typeof v === 'string' && v.trim().length > 0

export const run = async (ctx: CheckContext) => {
  const b = ctx.beneficiary
  if (!b) {
    return makeResult(spec, ctx, { status: 'skip', evidence: 'Assessed once the payee is registered.', source: SOURCE })
  }
  const amountEur = ctx.out.amountEur ?? (ctx.extracted.invoice.currency === 'EUR' ? ctx.extracted.invoice.gross : null)
  if (amountEur === null) {
    return makeResult(spec, ctx, { status: 'skip', evidence: 'No EUR amount (FX failed); readiness against the EUR threshold not assessed.', source: SOURCE })
  }
  const address = present(ctx.extracted.payee.address) ? ctx.extracted.payee.address.trim() : null
  const beneficiary = { name: b.name, country: b.country, address, wallet: b.wallet, tax_id: b.tax_id }
  const orig = { legal_name: originator.legal_name, address: originator.address, country: originator.country }
  const missing: string[] = []
  if (!present(orig.legal_name)) missing.push('originator legal name')
  if (!present(orig.address)) missing.push('originator address')
  if (!present(orig.country)) missing.push('originator country')
  if (!present(beneficiary.name)) missing.push('payee name')
  if (!present(beneficiary.country)) missing.push('payee country')
  if (!address) missing.push('payee address')
  if (!present(beneficiary.wallet)) missing.push('payee wallet')
  const proof = parseOwnershipProof(b.ownership_proof_json)
  const above = amountEur >= THRESHOLD_EUR
  const data = { amount_eur: amountEur, threshold_eur: THRESHOLD_EUR, above, originator: orig, beneficiary, missing, ownership_proof_signed_at: proof?.signedAt ?? null }

  if (!above) {
    return makeResult(spec, ctx, {
      status: 'pass',
      evidence: `${eur(amountEur)} is below the EUR ${THRESHOLD_EUR.toLocaleString('en-GB')} self-hosted threshold; originator record (${orig.legal_name}, ${orig.country}) and payee record (${b.name}, ${b.country ?? 'country n/a'}${address ? ', address' : ''}) attached to the remittance anyway${missing.length ? `; missing: ${missing.join(', ')}` : ''}.`,
      source: SOURCE,
      data,
    })
  }
  if (missing.length > 0) {
    return makeResult(spec, ctx, {
      status: 'warn',
      evidence: `${eur(amountEur)} is above EUR ${THRESHOLD_EUR.toLocaleString('en-GB')}: the payee's CASP must verify ownership of the self-hosted wallet (Art. 14(5)) and will ask for ${missing.join(', ')}; complete the record before paying.`,
      source: SOURCE,
      data,
    })
  }
  return makeResult(spec, ctx, {
    status: 'pass',
    evidence: `${eur(amountEur)} above EUR ${THRESHOLD_EUR.toLocaleString('en-GB')}: originator and payee records complete; ownership proof ${proof ? `on file (${proof.signedAt.slice(0, 10)})` : 'not on file (see Wallet ownership proof)'}.`,
    source: SOURCE,
    data,
  })
}

export const travelRuleReadiness: CheckSpec = { ...spec, run }
