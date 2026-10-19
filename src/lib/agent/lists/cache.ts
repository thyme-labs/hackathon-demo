// Download-with-cache for public list files. Files land in <DATA_DIR>/lists/ with a
// sidecar meta.json recording when and from where they were fetched.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { agentEnv } from '../env'

export interface CachedFile {
  path: string
  fetchedAt: string
  sourceUrl: string
  fromCache: boolean
  bytes: number
}

const listsDir = (): string => join(agentEnv.dataDir(), 'lists')

const metaPath = (name: string): string => join(listsDir(), `${name}.meta.json`)

const readMeta = (name: string): { fetchedAt: string; sourceUrl: string } | null => {
  try {
    return JSON.parse(readFileSync(metaPath(name), 'utf8')) as { fetchedAt: string; sourceUrl: string }
  } catch {
    return null
  }
}

const ageHours = (iso: string): number => (Date.now() - new Date(iso).getTime()) / 3_600_000

/**
 * Returns the cached file when younger than maxAgeHours; otherwise downloads it.
 * When the download fails and a stale copy exists, the stale copy is returned.
 * Returns null when nothing is available (caller falls back to the committed sample).
 */
export const fetchCached = async (
  name: string,
  sourceUrl: string,
  maxAgeHours = 24,
  timeoutMs = 60_000,
): Promise<CachedFile | null> => {
  const dir = listsDir()
  const path = join(dir, name)
  const meta = readMeta(name)
  const have = existsSync(path) && meta !== null
  if (have && ageHours(meta.fetchedAt) < maxAgeHours) {
    return { path, fetchedAt: meta.fetchedAt, sourceUrl: meta.sourceUrl, fromCache: true, bytes: statSync(path).size }
  }
  if (!agentEnv.offline()) {
    try {
      const res = await fetch(sourceUrl, { signal: AbortSignal.timeout(timeoutMs) })
      if (res.ok) {
        const body = Buffer.from(await res.arrayBuffer())
        mkdirSync(dir, { recursive: true })
        writeFileSync(path, body)
        const fetchedAt = new Date().toISOString()
        writeFileSync(metaPath(name), JSON.stringify({ fetchedAt, sourceUrl }, null, 2))
        return { path, fetchedAt, sourceUrl, fromCache: false, bytes: body.length }
      }
    } catch {
      // fall through to stale copy / null
    }
  }
  if (have) {
    return { path, fetchedAt: meta.fetchedAt, sourceUrl: meta.sourceUrl, fromCache: true, bytes: statSync(path).size }
  }
  return null
}

export const readCachedText = (file: CachedFile): string => readFileSync(file.path, 'utf8')
