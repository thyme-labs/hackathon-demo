// Helpers for consumers of invoices.checklist_json (UI, reports, API routes).
import type { ChecklistEntry, ChecklistSnapshot } from './types'

const emptySnapshot = (): ChecklistSnapshot => ({
  entries: [],
  score: null,
  started_at: '',
  finished_at: null,
  list_versions: {},
  llm: { provider: 'none', calls: 0, cost_usd: 0, models: [] },
})

/** Parses checklist_json; tolerates a bare array of entries (older shape) and malformed JSON. */
export const parseChecklist = (json: string | null | undefined): ChecklistSnapshot => {
  if (!json) return emptySnapshot()
  try {
    const parsed = JSON.parse(json) as unknown
    if (Array.isArray(parsed)) return { ...emptySnapshot(), entries: parsed as ChecklistEntry[] }
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as ChecklistSnapshot).entries)) {
      return { ...emptySnapshot(), ...(parsed as ChecklistSnapshot) }
    }
  } catch {
    // fall through
  }
  return emptySnapshot()
}

/** Entries with a final status (pass/warn/fail/skip), e.g. for the remittance advice. */
export const finishedEntries = (snapshot: ChecklistSnapshot): ChecklistEntry[] =>
  snapshot.entries.filter((e) => e.status !== 'pending' && e.status !== 'running')
