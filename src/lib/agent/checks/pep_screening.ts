// Is the payee a current or recent politically exposed person? Natural persons only (AMLD Art. 3(9)).
// Two keyless sources: Wikidata SPARQL (humans with a P39 "position held", P582 end dates, P27 citizenship) and
// the OpenSanctions wd_oligarchs table. A Wikidata hit is a same-name match only: no date of birth is stored, so
// the evidence always says "identity not asserted". 12-month rule: AMLD5 Art. 22 / §4(5) Act 253/2008 Sb.
// Network-dependent, medium tier: a timeout is a neutral skip, never a warn.
import { agentEnv } from '../env'
import { bestMatch } from '../lists'
import { loadOligarchList, type OligarchEntry } from '../lists/wd-oligarchs'
import { type CheckContext, type CheckSpec, makeResult } from './context'
import { toCountryCode } from './country_risk'

const spec = { id: 'pep_screening', label: 'PEP screening', enforcement: 'agent', weight: 6 } as const

const WIKIDATA_SPARQL = 'https://query.wikidata.org/sparql'
const TIMEOUT_MS = 8_000
const RECENT_MONTHS = 12
const USER_AGENT = 'ThymePayroll/0.1 (hackathon demo)'

/** ISO 3166-1 alpha-2 → Wikidata country item, for the citizenship filter. */
const COUNTRY_QID: Record<string, string> = {
  UA: 'Q212', GE: 'Q230', IN: 'Q668', GB: 'Q145', RS: 'Q403', CZ: 'Q213', DE: 'Q183', PL: 'Q36', SK: 'Q214', SE: 'Q34',
  EE: 'Q191', KE: 'Q114', KP: 'Q423', US: 'Q30', AT: 'Q40', FR: 'Q142', IT: 'Q38', ES: 'Q29', NL: 'Q55', BE: 'Q31',
  PT: 'Q45', RO: 'Q218', BG: 'Q219', HU: 'Q28', HR: 'Q224', CH: 'Q39', NO: 'Q20', RU: 'Q159', BY: 'Q184', TR: 'Q43',
  MD: 'Q217', AM: 'Q399', KZ: 'Q232', LT: 'Q37', LV: 'Q211', FI: 'Q33', DK: 'Q35', IE: 'Q27', GR: 'Q41', SI: 'Q215',
  CY: 'Q229', LU: 'Q32', MT: 'Q233', BA: 'Q225', MK: 'Q221', AL: 'Q222', ME: 'Q236', IR: 'Q794', SY: 'Q858', MM: 'Q836',
  CN: 'Q148', JP: 'Q17', KR: 'Q884', CA: 'Q16', AU: 'Q408', BR: 'Q155', IL: 'Q801', AE: 'Q878', NG: 'Q1033', ZA: 'Q258',
  EG: 'Q79', PK: 'Q843', BD: 'Q902',
}
const QID_COUNTRY: Record<string, string> = Object.fromEntries(Object.entries(COUNTRY_QID).map(([cc, q]) => [q, cc]))

interface Position {
  label: string
  start: string | null
  end: string | null
}

interface WikidataPerson {
  qid: string
  label: string
  citizenships: string[]
  positions: Position[]
}

interface SparqlBinding {
  item?: { value: string }
  itemLabel?: { value: string }
  cit?: { value: string }
  posLabel?: { value: string }
  start?: { value: string }
  end?: { value: string }
}

const tail = (uri: string): string => uri.slice(uri.lastIndexOf('/') + 1)
const dateOf = (v: string | undefined): string | null => (v ? v.slice(0, 10) : null)

const sparqlFor = (name: string): string => {
  const safe = name.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ').slice(0, 80)
  const langs = ['en', 'de', 'cs', 'uk', 'ru', 'ka', 'sr', 'hi']
  const values = langs.map((l) => `"${safe}"@${l}`).join(' ')
  return `SELECT ?item ?itemLabel ?cit ?posLabel ?start ?end WHERE {
  VALUES ?name { ${values} }
  ?item rdfs:label ?name ; wdt:P31 wd:Q5 ; p:P39 ?st . ?st ps:P39 ?pos .
  OPTIONAL { ?st pq:P580 ?start } OPTIONAL { ?st pq:P582 ?end } OPTIONAL { ?item wdt:P27 ?cit }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". } } LIMIT 50`
}

/** Humans on Wikidata with this exact label and at least one position held. Throws on timeout / non-200. */
const queryWikidata = async (name: string): Promise<WikidataPerson[]> => {
  const url = `${WIKIDATA_SPARQL}?format=json&query=${encodeURIComponent(sparqlFor(name))}`
  const res = await fetch(url, {
    headers: { Accept: 'application/sparql-results+json', 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const body = (await res.json()) as { results?: { bindings?: SparqlBinding[] } }
  const people = new Map<string, WikidataPerson>()
  for (const row of body.results?.bindings ?? []) {
    if (!row.item?.value) continue
    const qid = tail(row.item.value)
    const person = people.get(qid) ?? { qid, label: row.itemLabel?.value ?? qid, citizenships: [], positions: [] }
    const cit = row.cit?.value ? tail(row.cit.value) : null
    if (cit && !person.citizenships.includes(cit)) person.citizenships.push(cit)
    const pos: Position = { label: row.posLabel?.value ?? 'public office', start: dateOf(row.start?.value), end: dateOf(row.end?.value) }
    if (!person.positions.some((p) => p.label === pos.label && p.start === pos.start && p.end === pos.end)) person.positions.push(pos)
    people.set(qid, person)
  }
  return [...people.values()]
}

const citizenshipText = (p: WikidataPerson): string => (p.citizenships.length ? p.citizenships.map((q) => QID_COUNTRY[q] ?? q).join('/') : 'citizenship n/a')

interface NameVerdict {
  name: string
  status: 'pass' | 'warn'
  text: string
  oligarch: { qid: string; alias: string; flags: string[] } | null
  wikidata: WikidataPerson[]
}

const screenName = (name: string, payeeQid: string | null, payeeCc: string | null, people: WikidataPerson[], oligarchs: OligarchEntry[], cutoffIso: string): NameVerdict => {
  const oligarchHit = oligarchs
    .map((e) => ({ e, m: bestMatch(name, [e.name]) }))
    .find(({ m }) => m.kind === 'exact' || m.kind === 'tokens')
  const oligarch = oligarchHit ? { qid: oligarchHit.e.qid, alias: oligarchHit.m.alias, flags: oligarchHit.e.flags } : null
  const same = people.filter((p) => !payeeQid || p.citizenships.length === 0 || p.citizenships.includes(payeeQid))
  const foreign = people.filter((p) => !same.includes(p))
  const current = same.flatMap((p) => p.positions.filter((pos) => pos.end === null || pos.end >= cutoffIso).map((pos) => ({ p, pos })))
  const parts: string[] = []
  let status: 'pass' | 'warn' = 'pass'
  if (oligarch) {
    status = 'warn'
    parts.push(`"${name}" matches OpenSanctions wd_oligarchs (${oligarch.alias}${oligarch.flags.length ? `; ${oligarch.flags.join(', ')}` : ''}); enhanced due diligence.`)
  }
  if (current.length > 0) {
    status = 'warn'
    const { p, pos } = current[0]
    parts.push(
      `"${name}" matches Wikidata ${p.qid} (${citizenshipText(p)}): ${pos.label} ${pos.end ? `until ${pos.end}` : 'ongoing'} — current or recent PEP (${RECENT_MONTHS}-month rule, AMLD5 Art. 22 / §4(5) Act 253/2008). Same-name match only: no date of birth on file; owner confirms identity.`,
    )
  } else if (same.length > 0) {
    const ends = same.flatMap((p) => p.positions.map((pos) => pos.end)).filter((e): e is string => !!e).sort()
    const last = ends.at(-1) ?? 'n/a'
    const p = same[0]
    parts.push(`"${name}" shares its name with Wikidata ${p.qid} (${citizenshipText(p)}, last public office ended ${last}, > ${RECENT_MONTHS} months ago): not a current PEP; identity not asserted.`)
  }
  if (foreign.length > 0) {
    parts.push(`${foreign.length} further Wikidata namesake(s) with public office hold a different citizenship (${foreign.map((p) => `${p.qid} ${citizenshipText(p)}`).join(', ')}); not treated as a PEP for a ${payeeCc ?? 'n/a'} payee.`)
  }
  if (parts.length === 0) parts.push(`"${name}" has no Wikidata entry with a public office and is not on the wd_oligarchs list.`)
  return { name, status, text: parts.join(' '), oligarch, wikidata: people }
}

export const run = async (ctx: CheckContext) => {
  const names = [...new Set([ctx.beneficiary?.name, ctx.extracted.payee.name].map((n) => n?.trim()).filter((n): n is string => !!n))]
  const payeeCc = toCountryCode(ctx.beneficiary?.country ?? ctx.extracted.payee.country)
  const payeeQid = payeeCc ? (COUNTRY_QID[payeeCc] ?? null) : null
  const oligarchs = await loadOligarchList()
  const at = ctx.now.toISOString()
  const source = `Wikidata SPARQL (P39 positions, P582 end dates) at ${at}; OpenSanctions wd_oligarchs ${oligarchs.fetchedAt ? oligarchs.fetchedAt.slice(0, 10) : 'not loaded'} (${oligarchs.source}, ${oligarchs.entries.length} names; CC-BY-NC, demo use)`

  if (ctx.payeeType.type === 'company') {
    return makeResult(spec, ctx, { status: 'skip', evidence: 'Entity payee; PEP screening applies to natural persons (AMLD Art. 3(9)).', source, data: { screened: names, type: 'company' } })
  }
  if (agentEnv.offline()) {
    return makeResult(spec, ctx, { status: 'skip', evidence: 'Offline mode (AGENT_OFFLINE=1): Wikidata not queried; PEP status not screened this run.', source, data: { offline: true, screened: names } })
  }

  const cutoffIso = new Date(ctx.now.getTime() - RECENT_MONTHS * 30.44 * 86_400_000).toISOString().slice(0, 10)
  const started = Date.now()
  let lookups: WikidataPerson[][]
  try {
    lookups = await Promise.all(names.map((n) => queryWikidata(n)))
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    const timedOut = /timeout|aborted|timed out/i.test(msg)
    return makeResult(spec, ctx, {
      status: 'skip',
      evidence: `Wikidata query ${timedOut ? 'timed out' : `failed (${msg})`}; PEP status not screened this run.`,
      source,
      data: { screened: names, country: payeeCc, error: msg, ms: Date.now() - started },
    })
  }
  const verdicts = names.map((n, i) => screenName(n, payeeQid, payeeCc, lookups[i], oligarchs.entries, cutoffIso))
  const status = verdicts.some((v) => v.status === 'warn') ? 'warn' : 'pass'
  return makeResult(spec, ctx, {
    status,
    evidence: verdicts.map((v) => v.text).join(' '),
    source,
    data: {
      screened: names,
      country: payeeCc,
      cutoff: cutoffIso,
      wikidata: verdicts.flatMap((v) => v.wikidata),
      oligarch: { checked: oligarchs.entries.length, hits: verdicts.map((v) => v.oligarch).filter((h) => h !== null) },
      ms: Date.now() - started,
    },
  })
}

export const pepScreening: CheckSpec = { ...spec, run }
