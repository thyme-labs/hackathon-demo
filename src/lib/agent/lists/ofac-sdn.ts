// OFAC SDN list (sdn.csv, no header). Columns: ent_num, SDN_Name, SDN_Type, Program,
// Title, Call_Sign, Vess_type, Tonnage, GRT, Vess_flag, Vess_owner, Remarks. '-0-' is null.
// Remarks carry "Digital Currency Address - ETH 0x..." identifiers.
import sample from '../../../../config/sanctions-sample.json'
import { fetchCached, readCachedText } from './cache'
import { parseCsv } from './csv'

export const OFAC_SDN_URL = 'https://www.treasury.gov/ofac/downloads/sdn.csv'

export interface SdnEntry {
  entNum: string
  name: string
  sdnType: string
  program: string
  ethAddresses: string[]
}

export interface SdnList {
  entries: SdnEntry[]
  ethIndex: Map<string, SdnEntry>
  fetchedAt: string
  source: 'download' | 'cache' | 'sample'
  sourceUrl: string
}

const ETH_RE = /Digital Currency Address - ETH (0x[0-9a-fA-F]{40})/g

const nil = (v: string | undefined): string => (!v || v.trim() === '-0-' ? '' : v.trim())

const buildIndex = (entries: SdnEntry[]): Map<string, SdnEntry> => {
  const idx = new Map<string, SdnEntry>()
  for (const e of entries) for (const a of e.ethAddresses) idx.set(a, e)
  return idx
}

const parseSdnCsv = (text: string): SdnEntry[] => {
  const rows = parseCsv(text, ',')
  const entries: SdnEntry[] = []
  for (const row of rows) {
    if (row.length < 4 || !/^\d+$/.test(row[0] ?? '')) continue
    const remarks = nil(row[11])
    const eth = [...remarks.matchAll(ETH_RE)].map((m) => m[1].toLowerCase())
    entries.push({
      entNum: row[0],
      name: nil(row[1]),
      sdnType: nil(row[2]) || 'entity',
      program: nil(row[3]),
      ethAddresses: [...new Set(eth)],
    })
  }
  return entries
}

const sampleList = (): SdnList => {
  const entries: SdnEntry[] = sample.ofac_sdn.entries.map((e) => ({
    entNum: e.ent_num,
    name: e.name,
    sdnType: e.sdn_type,
    program: e.program,
    ethAddresses: e.eth_addresses.map((a) => a.toLowerCase()),
  }))
  return {
    entries,
    ethIndex: buildIndex(entries),
    fetchedAt: sample.ofac_sdn.fetched_at,
    source: 'sample',
    sourceUrl: sample.ofac_sdn.source_url,
  }
}

let memo: Promise<SdnList> | null = null

export const loadSdnList = (): Promise<SdnList> => {
  if (!memo) {
    memo = (async () => {
      const file = await fetchCached('ofac-sdn.csv', OFAC_SDN_URL)
      if (!file) return sampleList()
      try {
        const entries = parseSdnCsv(readCachedText(file))
        if (entries.length === 0) return sampleList()
        return {
          entries,
          ethIndex: buildIndex(entries),
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

export const resetSdnListCache = (): void => {
  memo = null
}
