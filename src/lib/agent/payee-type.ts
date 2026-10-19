// Resolves whether the payee is a natural person or a company. Order: the beneficiary
// registry (owner-approved) wins; then the extractor's classification; then a deterministic
// reading of the printed fields. A printed legal form or LEI always upgrades to company,
// so a model slip ("Studio Nord Ltd" as a person) cannot downgrade a firm; the reverse
// (company -> person) is never done automatically.
import type { ExtractedInvoice } from './extract'
import type { BeneficiaryRow, BeneficiaryType } from './types'

export type PayeeTypeSource = 'registry' | 'extraction' | 'heuristic'

export interface PayeeTypeResolution {
  type: BeneficiaryType
  source: PayeeTypeSource
  reason: string
}

// Legal-form suffixes and abbreviations as printed on invoices (EU, UK, US, CEE, Nordics).
const LEGAL_FORM =
  /(^|[\s,])(ltd|limited|llc|l\.l\.c|inc|incorporated|corp|corporation|plc|llp|lp|gmbh|ag|ug|kg|ohg|s\.?r\.?o|a\.?s|sp\.? ?z ?o\.?o|s\.?a|s\.?a\.?s|s\.?a\.?r\.?l|s\.?r\.?l|s\.?p\.?a|b\.?v|n\.?v|oü|oy|ab|aps|d\.?o\.?o|kft|zrt|pty|k\.?s|v\.?o\.?s)\.?(?=$|[\s,.)])/i

// Trade words that only firms carry in a name.
const ORGANISATION_WORD =
  /\b(studio|agency|group|partners|consulting|solutions|services|technologies|technology|labs?|software|digital|media|holdings?|company|ventures|systems|networks|associates|foundation|institute|university|bank|trust|enterprises?)\b/i

// Tax ids that are only issued to firms: anything labelled VAT, a company registration
// number, or a Czech IČO. Personal numbers (PAN, national tax ids) do not match.
const COMPANY_TAX_ID = /\b(vat|ust-?id|tva|iva|i[čc]o|crn|company (no|number|reg)|reg(istration)?\.? ?(no|number))\b/i

export const inferPayeeType = (payee: ExtractedInvoice['payee']): { type: BeneficiaryType; reason: string } => {
  if (payee.lei) return { type: 'company', reason: `LEI ${payee.lei} printed` }
  const form = LEGAL_FORM.exec(payee.name)
  if (form) return { type: 'company', reason: `legal form "${form[2]}" in the name` }
  if (payee.tax_id && COMPANY_TAX_ID.test(payee.tax_id)) return { type: 'company', reason: `company tax id ${payee.tax_id}` }
  const word = ORGANISATION_WORD.exec(payee.name)
  if (word) return { type: 'company', reason: `"${word[1]}" in the name` }
  return { type: 'person', reason: 'personal name, no legal form, VAT id or LEI' }
}

export const resolvePayeeType = (extracted: ExtractedInvoice, beneficiary: BeneficiaryRow | null): PayeeTypeResolution => {
  if (beneficiary) return { type: beneficiary.type, source: 'registry', reason: `registered as ${beneficiary.type}` }
  const inferred = inferPayeeType(extracted.payee)
  const extractedType = extracted.payee.type ?? null
  if (extractedType === 'person' && inferred.type === 'company') {
    return { type: 'company', source: 'heuristic', reason: `extractor said person but ${inferred.reason}` }
  }
  if (extractedType) return { type: extractedType, source: 'extraction', reason: 'classified by the extractor' }
  return { type: inferred.type, source: 'heuristic', reason: inferred.reason }
}
