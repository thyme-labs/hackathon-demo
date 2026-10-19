// EU consolidated financial sanctions list (CSV, semicolon separated, one row per
// alias/address/identification). Parsed into one subject per Entity_LogicalId.
import sample from '../../../../config/sanctions-sample.json'
import { fetchCached, readCachedText } from './cache'
import { parseCsv } from './csv'

export const EU_FSF_URL =
  'https://webgate.ec.europa.eu/fsd/fsf/public/files/csvFullSanctionsList_1_1/content?token=dG9rZW4tMjAxNw'

export interface EuSubject {
  logicalId: string
  euReference: string
  subjectType: 'P' | 'E' | string
  names: string[]
  programme: string
  remark: string
  ethAddresses: string[]
  birthYears: string[]
  countries: string[]
}

export interface EuList {
  subjects: EuSubject[]
  fileGenerationDate: string
  fetchedAt: string
  source: 'download' | 'cache' | 'sample'
  sourceUrl: string
}

const ETH_RE = /0x[0-9a-fA-F]{40}/g

/** The EU file prints dd/mm/yyyy; store ISO. */
const toIsoDate = (s: string): string => {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s.trim())
  return m ? `${m[3]}-${m[2]}-${m[1]}` : s.trim()
}

const parseEuCsv = (text: string): { subjects: EuSubject[]; fileGenerationDate: string } => {
  const rows = parseCsv(text, ';')
  const header = rows[0] ?? []
  const col = (name: string): number => header.indexOf(name)
  const c = {
    gen: col('fileGenerationDate'),
    id: col('Entity_LogicalId'),
    ref: col('Entity_EU_ReferenceNumber'),
    type: col('Entity_SubjectType'),
    prog: col('Entity_Regulation_Programme'),
    remark: col('Entity_Remark'),
    whole: col('NameAlias_WholeName'),
    first: col('NameAlias_FirstName'),
    last: col('NameAlias_LastName'),
    aliasRemark: col('NameAlias_Remark'),
    birthYear: col('BirthDate_Year'),
    country: col('Address_CountryIso2Code'),
    citizenship: col('Citizenship_CountryIso2Code'),
  }
  const byId = new Map<string, EuSubject>()
  let fileGenerationDate = ''
  for (const row of rows.slice(1)) {
    const id = row[c.id]
    if (!id) continue
    if (!fileGenerationDate && c.gen >= 0) fileGenerationDate = toIsoDate(row[c.gen] ?? '')
    let subject = byId.get(id)
    if (!subject) {
      subject = {
        logicalId: id,
        euReference: row[c.ref] ?? '',
        subjectType: row[c.type] ?? '',
        names: [],
        programme: row[c.prog] ?? '',
        remark: row[c.remark] ?? '',
        ethAddresses: [],
        birthYears: [],
        countries: [],
      }
      byId.set(id, subject)
    }
    const whole = (row[c.whole] ?? '').trim()
    const composed = [row[c.first], row[c.last]].filter(Boolean).join(' ').trim()
    const name = whole || composed
    if (name && !subject.names.includes(name)) subject.names.push(name)
    for (const field of [row[c.remark], row[c.aliasRemark]]) {
      for (const m of (field ?? '').matchAll(ETH_RE)) {
        const addr = m[0].toLowerCase()
        if (!subject.ethAddresses.includes(addr)) subject.ethAddresses.push(addr)
      }
    }
    const by = row[c.birthYear]
    if (by && !subject.birthYears.includes(by)) subject.birthYears.push(by)
    for (const idx of [c.country, c.citizenship]) {
      const cc = idx >= 0 ? row[idx] : ''
      if (cc && !subject.countries.includes(cc)) subject.countries.push(cc)
    }
  }
  return { subjects: [...byId.values()], fileGenerationDate }
}

const sampleList = (): EuList => ({
  subjects: sample.eu_consolidated.subjects.map((s) => ({
    logicalId: s.logical_id,
    euReference: s.eu_reference,
    subjectType: s.subject_type,
    names: s.names,
    programme: s.programme,
    remark: s.remark,
    ethAddresses: s.eth_addresses.map((a) => a.toLowerCase()),
    birthYears: [],
    countries: [],
  })),
  fileGenerationDate: sample.eu_consolidated.file_generation_date,
  fetchedAt: sample.eu_consolidated.file_generation_date,
  source: 'sample',
  sourceUrl: sample.eu_consolidated.source_url,
})

let memo: Promise<EuList> | null = null

export const loadEuList = (): Promise<EuList> => {
  if (!memo) {
    memo = (async () => {
      const file = await fetchCached('eu-consolidated.csv', EU_FSF_URL)
      if (!file) return sampleList()
      try {
        const parsed = parseEuCsv(readCachedText(file))
        if (parsed.subjects.length === 0) return sampleList()
        return {
          ...parsed,
          fetchedAt: file.fetchedAt,
          source: file.fromCache ? 'cache' : 'download',
          sourceUrl: file.sourceUrl,
        }
      } catch {
        return sampleList()
      }
    })()
  }
  return memo
}

export const resetEuListCache = (): void => {
  memo = null
}
