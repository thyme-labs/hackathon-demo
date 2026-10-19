import sample from '../../../../config/sanctions-sample.json'
import { loadEuList, resetEuListCache } from './eu-fsf'
import { loadSdnList, resetSdnListCache } from './ofac-sdn'

export { loadEuList, type EuList, type EuSubject } from './eu-fsf'
export { loadSdnList, type SdnEntry, type SdnList } from './ofac-sdn'
export { bestMatch, matchName, normaliseName, type NameMatch } from './names'

export interface CzEntry {
  names: string[]
  reason: string
}

/** Czech national list (Act 1/2023 Sb.): hand-maintained extract, see config/sanctions-sample.json. */
export const loadCzList = (): { entries: CzEntry[]; asOf: string; sourceUrl: string } => ({
  entries: sample.cz_national.entries as CzEntry[],
  asOf: sample.cz_national.as_of,
  sourceUrl: sample.cz_national.source_url,
})

/** Human-readable list versions for the checklist footer. */
export const listVersions = async (): Promise<Record<string, string>> => {
  const [eu, sdn] = await Promise.all([loadEuList(), loadSdnList()])
  const cz = loadCzList()
  return {
    eu_consolidated: `${eu.fileGenerationDate || 'n/a'} (${eu.source}, ${eu.subjects.length} subjects)`,
    ofac_sdn: `${sdn.fetchedAt.slice(0, 10)} (${sdn.source}, ${sdn.entries.length} entries, ${sdn.ethIndex.size} ETH addresses)`,
    cz_national: `${cz.asOf} (manual extract, ${cz.entries.length} entries)`,
  }
}

export const resetListCaches = (): void => {
  resetEuListCache()
  resetSdnListCache()
}
