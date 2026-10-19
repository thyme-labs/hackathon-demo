// Beneficiary matching: tax id first, then wallet, then normalised name.
// Never wallet-only when the name clearly differs? We still match (so the mismatch surfaces
// in wallet_matches_file / known_beneficiary) but record how the match was made.
import type { ExtractedInvoice } from './extract'
import { matchName } from './lists/names'
import type { BeneficiaryRow } from './types'
import type { MatchedBy } from './checks/context'

const normTaxId = (s: string | null | undefined): string => (s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')

export interface BeneficiaryMatch {
  beneficiary: BeneficiaryRow | null
  matchedBy: MatchedBy
}

export const matchBeneficiary = (extracted: ExtractedInvoice, beneficiaries: BeneficiaryRow[]): BeneficiaryMatch => {
  const taxId = normTaxId(extracted.payee.tax_id)
  if (taxId) {
    const hit = beneficiaries.find((b) => normTaxId(b.tax_id) === taxId)
    if (hit) return { beneficiary: hit, matchedBy: 'tax_id' }
  }
  const wallet = extracted.payment.wallet
  if (wallet) {
    const hit = beneficiaries.find((b) => b.wallet?.toLowerCase() === wallet)
    if (hit) return { beneficiary: hit, matchedBy: 'wallet' }
  }
  const byName = beneficiaries
    .map((b) => ({ b, m: matchName(extracted.payee.name, b.name, 0.9) }))
    .filter((x) => x.m.kind === 'exact' || x.m.kind === 'tokens' || x.m.kind === 'fuzzy')
    .sort((a, z) => z.m.score - a.m.score)[0]
  if (byName) return { beneficiary: byName.b, matchedBy: 'name' }
  return { beneficiary: null, matchedBy: null }
}
