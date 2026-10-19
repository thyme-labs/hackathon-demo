// Name normalisation and matching helpers shared by the screening checks.

export const normaliseName = (s: string): string =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const LEGAL_SUFFIXES = new Set([
  'ltd', 'limited', 'llc', 'inc', 'gmbh', 'sas', 'sa', 'srl', 'sro', 'oou', 'ou', 'bv', 'plc', 'co', 'company', 'corp',
  'corporation', 'ag', 'kft', 'doo', 'fop', 'pe', 'pr', 'ie',
])

export const nameTokens = (s: string): string[] =>
  normaliseName(s)
    .split(' ')
    .filter((t) => t.length > 1 && !LEGAL_SUFFIXES.has(t))

const bigrams = (s: string): Set<string> => {
  const out = new Set<string>()
  const compact = s.replace(/\s/g, '')
  for (let i = 0; i < compact.length - 1; i++) out.add(compact.slice(i, i + 2))
  return out
}

/** Sorensen-Dice similarity on character bigrams, 0..1. */
export const diceSimilarity = (a: string, b: string): number => {
  const A = bigrams(normaliseName(a))
  const B = bigrams(normaliseName(b))
  if (A.size === 0 || B.size === 0) return 0
  let hits = 0
  for (const g of A) if (B.has(g)) hits++
  return (2 * hits) / (A.size + B.size)
}

export type NameMatchKind = 'exact' | 'tokens' | 'fuzzy' | 'none'

export interface NameMatch {
  kind: NameMatchKind
  score: number
  alias: string
}

/**
 * Compares a query name with one list alias.
 * exact: same normalised string. tokens: every token of the shorter side is in the longer
 * side (handles "KOVALENKO, Anna" vs "Anna Kovalenko"). fuzzy: dice >= threshold.
 */
export const matchName = (query: string, alias: string, fuzzyThreshold = 0.86): NameMatch => {
  const q = normaliseName(query)
  const a = normaliseName(alias)
  if (!q || !a) return { kind: 'none', score: 0, alias }
  if (q === a) return { kind: 'exact', score: 1, alias }
  const qt = nameTokens(query)
  const at = nameTokens(alias)
  if (qt.length >= 2 && at.length >= 2) {
    const [shorter, longer] = qt.length <= at.length ? [qt, at] : [at, qt]
    const longerSet = new Set(longer)
    if (shorter.every((t) => longerSet.has(t))) return { kind: 'tokens', score: 0.95, alias }
  }
  const dice = diceSimilarity(q, a)
  if (dice >= fuzzyThreshold) return { kind: 'fuzzy', score: dice, alias }
  return { kind: 'none', score: dice, alias }
}

export const bestMatch = (query: string, aliases: string[], fuzzyThreshold?: number): NameMatch => {
  let best: NameMatch = { kind: 'none', score: 0, alias: '' }
  for (const alias of aliases) {
    const m = matchName(query, alias, fuzzyThreshold)
    if (m.kind !== 'none' && m.score > best.score) best = m
    if (best.kind === 'exact') break
  }
  return best
}
