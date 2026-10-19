// Server-only: the auto-pay settings the compliance pipeline runs with. The owner edits them on
// /settings (settings table, keys autoPayThreshold / autoPayEnabled); AUTO_PAY_THRESHOLD is the fallback.
import { serverEnv } from '../env'
import { settings } from '../store/repos'

if (typeof window !== 'undefined') {
  throw new Error('src/lib/server/autopay.ts is server-only')
}

export const AUTO_PAY_KEYS = { threshold: 'autoPayThreshold', enabled: 'autoPayEnabled' } as const

export interface AutoPaySettings {
  /** Score an invoice of an active, trusted payee needs to be paid without the owner (0..100). */
  threshold: number
  /** False: every approved invoice is held for the owner instead of being handed to the payment agent. */
  enabled: boolean
  /** Where the threshold came from. */
  source: 'settings' | 'env'
}

export function clampThreshold(value: number): number {
  if (!Number.isFinite(value)) return 100
  return Math.min(100, Math.max(0, Math.round(value)))
}

export function readAutoPaySettings(): AutoPaySettings {
  const stored = settings.get(AUTO_PAY_KEYS.threshold)
  const parsed = stored === null ? Number.NaN : Number(stored)
  const fromSettings = Number.isFinite(parsed)
  const threshold = clampThreshold(fromSettings ? parsed : serverEnv.autoPayThreshold())
  const enabledRaw = settings.get(AUTO_PAY_KEYS.enabled)
  const enabled = enabledRaw === null ? true : enabledRaw === '1' || enabledRaw === 'true'
  return { threshold, enabled, source: fromSettings ? 'settings' : 'env' }
}

/** "auto-pay ≥ 90" or "auto-pay off": the chip shown on the dashboard and the agents page. */
export function autoPayChipLabel(s: AutoPaySettings): string {
  return s.enabled ? `auto-pay ≥ ${s.threshold}` : 'auto-pay off'
}
