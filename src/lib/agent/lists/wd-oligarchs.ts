// OpenSanctions "Russian Oligarch/Billionaires Database" (wd_oligarchs): Wikidata-derived persons on the
// Navalny 35, CAATSA 2018, Forbes 2021 and EU/US lists. The dataset's targets.simple.csv carries no names
// (every row reads "Person"), so the source table (qid,name,notes,eu_list,navalny35,...) is the file cached
// here, next to the sanctions lists. CC-BY-NC; demo use only.
import { fetchCached, readCachedText } from './cache'
import { parseCsv } from './csv'

export const WD_OLIGARCHS_URL = 'https://data.opensanctions.org/datasets/latest/wd_oligarchs/source.csv'

export interface OligarchEntry {
  qid: string
  name: string
  /** Which of the underlying lists carry the person (eu_list, navalny35, caatsa2018, forbes2021, us_ofac, ...). */
  flags: string[]
}

export interface OligarchList {
  entries: OligarchEntry[]
  fetchedAt: string | null
  source: 'download' | 'cache' | 'none'
  sourceUrl: string
}

const FLAG_COLUMNS = ['eu_list', 'navalny35', 'caatsa2018', 'forbes2021', 'us_ofac', 'ukr_forbes', 'wp_billionaires', 'left_russia']

const parseOligarchCsv = (text: string): OligarchEntry[] => {
  const rows = parseCsv(text, ',')
  const header = (rows[0] ?? []).map((h) => h.trim().toLowerCase())
  const iQid = header.indexOf('qid')
  const iName = header.indexOf('name')
  if (iQid < 0 || iName < 0) return []
  const flagIdx = FLAG_COLUMNS.map((f) => [f, header.indexOf(f)] as const).filter(([, i]) => i >= 0)
  const entries: OligarchEntry[] = []
  for (const row of rows.slice(1)) {
    const name = (row[iName] ?? '').trim()
    if (!name || name.toLowerCase() === 'person') continue
    entries.push({
      qid: (row[iQid] ?? '').trim(),
      name,
      flags: flagIdx.filter(([, i]) => /^(yes|true|1)$/i.test((row[i] ?? '').trim())).map(([f]) => f),
    })
  }
  return entries
}

let memo: Promise<OligarchList> | null = null

/** Cached 24 h under <DATA_DIR>/lists/wd-oligarchs.csv; empty (source 'none') when offline with no copy on disk. */
export const loadOligarchList = (): Promise<OligarchList> => {
  if (!memo) {
    memo = (async () => {
      const file = await fetchCached('wd-oligarchs.csv', WD_OLIGARCHS_URL, 24, 15_000)
      if (!file) return { entries: [], fetchedAt: null, source: 'none', sourceUrl: WD_OLIGARCHS_URL }
      try {
        return {
          entries: parseOligarchCsv(readCachedText(file)),
          fetchedAt: file.fetchedAt,
          source: file.fromCache ? 'cache' : 'download',
          sourceUrl: file.sourceUrl,
        }
      } catch {
        return { entries: [], fetchedAt: file.fetchedAt, source: 'none', sourceUrl: file.sourceUrl }
      }
    })()
  }
  return memo
}

export const resetOligarchListCache = (): void => {
  memo = null
}
