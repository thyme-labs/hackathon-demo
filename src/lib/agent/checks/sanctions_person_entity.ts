import { bestMatch, loadCzList, loadEuList, loadSdnList, type NameMatch } from '../lists'
import { type CheckContext, type CheckSpec, makeResult } from './context'

const spec = { id: 'sanctions_person_entity', label: 'Sanctions: person / entity', enforcement: 'agent', weight: 12 } as const

interface Hit {
  list: string
  name: string
  match: NameMatch
  ref: string
}

export const run = async (ctx: CheckContext) => {
  const names = [...new Set([ctx.beneficiary?.name, ctx.extracted.payee.name].filter((n): n is string => !!n))]
  const { type } = ctx.payeeType
  const [eu, sdn] = await Promise.all([loadEuList(), loadSdnList()])
  const cz = loadCzList()
  const hits: Hit[] = []
  const wantedEuType = type === 'company' ? 'E' : 'P'
  for (const name of names) {
    for (const s of eu.subjects) {
      if (s.subjectType !== wantedEuType) continue
      const m = bestMatch(name, s.names)
      if (m.kind !== 'none') hits.push({ list: 'EU consolidated', name, match: m, ref: `${s.euReference} ${s.programme}`.trim() })
    }
    for (const e of sdn.entries) {
      const isIndividual = e.sdnType.toLowerCase() === 'individual'
      if ((type === 'person') !== isIndividual) continue
      const m = bestMatch(name, [e.name])
      if (m.kind !== 'none') hits.push({ list: 'OFAC SDN', name, match: m, ref: `#${e.entNum} ${e.program}`.trim() })
    }
    for (const e of cz.entries) {
      const m = bestMatch(name, e.names)
      if (m.kind !== 'none') hits.push({ list: 'CZ national', name, match: m, ref: e.reason })
    }
  }
  const source = `EU consolidated list ${eu.fileGenerationDate || 'n/a'} (${eu.source}); OFAC SDN ${sdn.fetchedAt.slice(0, 10)} (${sdn.source}); CZ national list ${cz.asOf} (manual extract, ${cz.entries.length} entries)`
  const strong = hits.filter((h) => h.match.kind === 'exact' || h.match.kind === 'tokens')
  const fuzzy = hits.filter((h) => h.match.kind === 'fuzzy')
  const describe = (h: Hit) => `${h.list}: "${h.name}" ~ "${h.match.alias}" (${h.match.kind}, ${h.match.score.toFixed(2)}, ${h.ref})`
  if (strong.length) {
    return makeResult(spec, ctx, {
      status: 'fail',
      evidence: `Name hit on a sanctions list: ${strong.slice(0, 3).map(describe).join('; ')}. Payment stopped; notify FAU (Act 69/2006 §10).`,
      source,
      data: { hits: hits.slice(0, 10) },
    })
  }
  if (fuzzy.length) {
    return makeResult(spec, ctx, {
      status: 'warn',
      evidence: `Near match needs a human look: ${fuzzy.slice(0, 3).map(describe).join('; ')}.`,
      source,
      data: { hits: hits.slice(0, 10) },
    })
  }
  return makeResult(spec, ctx, {
    status: 'pass',
    evidence: `${names.map((n) => `"${n}"`).join(' and ')} (${type}) not found on the EU consolidated list (${eu.subjects.length} subjects), OFAC SDN (${sdn.entries.length} entries) or the CZ national list.`,
    source,
    data: { screened: names, type, type_source: ctx.payeeType.source },
  })
}

export const sanctionsPersonEntity: CheckSpec = { ...spec, run }
