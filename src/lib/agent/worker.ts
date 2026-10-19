// In-process queue worker: one invoice at a time, guarded by a lock shared between the
// interval and the "run now" button.
import { type InvestigationResult, investigate } from './pipeline'
import type { PipelineDeps } from './types'

const state = { locked: false, timer: null as ReturnType<typeof setInterval> | null, lastRunAt: null as string | null, lastError: null as string | null }

/** Processes the next queued invoice, if any. Returns null when idle or when another run holds the lock. */
export const processQueue = async (deps: PipelineDeps): Promise<InvestigationResult | null> => {
  if (state.locked) return null
  state.locked = true
  try {
    const next = deps.store.nextQueuedInvoice()
    if (!next) return null
    state.lastRunAt = new Date().toISOString()
    const result = await investigate(next.id, deps)
    state.lastError = null
    return result
  } catch (error) {
    state.lastError = error instanceof Error ? error.message : String(error)
    return null
  } finally {
    state.locked = false
  }
}

export interface Worker {
  start(): void
  stop(): void
  runOnce(): Promise<InvestigationResult | null>
  status(): { running: boolean; busy: boolean; lastRunAt: string | null; lastError: string | null }
}

export const createWorker = (deps: PipelineDeps, intervalMs = 5_000): Worker => ({
  start() {
    if (state.timer) return
    state.timer = setInterval(() => {
      void processQueue(deps)
    }, intervalMs)
  },
  stop() {
    if (state.timer) clearInterval(state.timer)
    state.timer = null
  },
  runOnce: () => processQueue(deps),
  status: () => ({ running: state.timer !== null, busy: state.locked, lastRunAt: state.lastRunAt, lastError: state.lastError }),
})
