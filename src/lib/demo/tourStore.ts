// Client-side state of the guided tour: active flag + current step, kept in sessionStorage so a reload or a
// navigation mid-tour resumes where it was. Framework-free; React reads it through useSyncExternalStore.
import { useSyncExternalStore } from 'react'

const STORAGE_KEY = 'tp-tour'

export interface TourState {
  active: boolean
  step: number
}

const INACTIVE: TourState = { active: false, step: 0 }
let state: TourState = INACTIVE
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

function persist(): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // private mode or storage disabled: the tour still works for this page load
  }
}

function set(next: TourState): void {
  state = next
  persist()
  emit()
}

export const tourStore = {
  get: (): TourState => state,
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
  /** Client only, after mount: restore the persisted state. */
  hydrate(): void {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY)
      if (!raw) return
      const parsed = JSON.parse(raw) as Partial<TourState>
      if (typeof parsed.active === 'boolean' && typeof parsed.step === 'number') {
        state = { active: parsed.active, step: Math.max(0, Math.floor(parsed.step)) }
        emit()
      }
    } catch {
      // ignore a malformed entry
    }
  },
  start(step = 0): void {
    set({ active: true, step })
  },
  stop(): void {
    set(INACTIVE)
  },
  go(step: number): void {
    set({ active: true, step: Math.max(0, step) })
  },
}

const getServerSnapshot = (): TourState => INACTIVE

export function useTour(): TourState {
  return useSyncExternalStore(tourStore.subscribe, tourStore.get, getServerSnapshot)
}
