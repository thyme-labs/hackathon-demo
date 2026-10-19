import lists from '../../../../config/lists.json'
import { type CheckContext, type CheckSpec, makeResult } from './context'

const spec = { id: 'country_risk', label: 'Country risk', enforcement: 'agent', weight: 8 } as const

const NAME_TO_CODE: Record<string, string> = {
  ukraine: 'UA', georgia: 'GE', india: 'IN', 'united kingdom': 'GB', uk: 'GB', 'great britain': 'GB', serbia: 'RS',
  czechia: 'CZ', 'czech republic': 'CZ', germany: 'DE', poland: 'PL', slovakia: 'SK', austria: 'AT', france: 'FR',
  spain: 'ES', italy: 'IT', netherlands: 'NL', belgium: 'BE', portugal: 'PT', romania: 'RO', bulgaria: 'BG',
  hungary: 'HU', croatia: 'HR', 'united states': 'US', usa: 'US', russia: 'RU', 'russian federation': 'RU',
  belarus: 'BY', iran: 'IR', syria: 'SY', 'north korea': 'KP', myanmar: 'MM', turkey: 'TR', 'türkiye': 'TR',
  switzerland: 'CH', norway: 'NO', moldova: 'MD', armenia: 'AM', kazakhstan: 'KZ', 'bosnia and herzegovina': 'BA',
}

export const toCountryCode = (raw: string | null | undefined): string | null => {
  if (!raw) return null
  const s = raw.trim()
  if (/^[A-Za-z]{2}$/.test(s)) return s.toUpperCase()
  return NAME_TO_CODE[s.toLowerCase()] ?? null
}

type Table = { source: string; source_url: string; as_of: string; treatment: string; countries: Record<string, string> }

export const run = async (ctx: CheckContext) => {
  const raw = ctx.beneficiary?.country ?? ctx.extracted.payee.country
  const code = toCountryCode(raw)
  const tables: { key: string; table: Table }[] = [
    { key: 'EU comprehensive sanctions regimes', table: lists.eu_comprehensive_sanctions_regimes },
    { key: 'FATF call for action', table: lists.fatf_call_for_action },
    { key: 'EU high-risk third countries', table: lists.eu_high_risk_third_countries },
    { key: 'FATF increased monitoring', table: lists.fatf_increased_monitoring },
  ]
  const source = tables.map((t) => `${t.key} as of ${t.table.as_of}`).join('; ')
  if (!code) {
    return makeResult(spec, ctx, {
      status: 'warn',
      evidence: `Country "${raw ?? ''}" could not be mapped to an ISO code; owner should set it on the beneficiary.`,
      source,
      data: { raw, code: null },
    })
  }
  const hits = tables.filter((t) => code in t.table.countries)
  const fails = hits.filter((t) => t.table.treatment === 'fail')
  const warns = hits.filter((t) => t.table.treatment === 'warn')
  if (fails.length) {
    return makeResult(spec, ctx, {
      status: 'fail',
      evidence: `${code} (${fails[0].table.countries[code]}) is on: ${fails.map((t) => t.key).join(', ')}. Country-level block for an unlicensed payroll flow.`,
      source,
      data: { code, hits: hits.map((t) => t.key) },
    })
  }
  if (warns.length) {
    return makeResult(spec, ctx, {
      status: 'warn',
      evidence: `${code} (${warns[0].table.countries[code]}) is on: ${warns.map((t) => t.key).join(', ')}. Enhanced due diligence; owner review.`,
      source,
      data: { code, hits: hits.map((t) => t.key) },
    })
  }
  return makeResult(spec, ctx, {
    status: 'pass',
    evidence: `${code} is not on the EU high-risk third-country list, the FATF grey or black list, or an EU comprehensive sanctions regime.`,
    source,
    data: { code, hits: [] },
  })
}

export const countryRisk: CheckSpec = { ...spec, run }
