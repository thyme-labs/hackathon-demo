// Frankfurter (ECB reference rates, no key): GET /latest?from=USD&to=EUR
import { agentEnv } from '../env'
import type { FxQuote } from './tatum'

export const fetchFrankfurterRate = async (currency: string, timeoutMs = 8_000): Promise<FxQuote | null> => {
  if (agentEnv.offline()) return null
  try {
    const res = await fetch(
      `https://api.frankfurter.app/latest?from=${encodeURIComponent(currency)}&to=EUR`,
      { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) },
    )
    if (!res.ok) return null
    const body = (await res.json()) as { date?: string; rates?: Record<string, number> }
    const value = body.rates?.EUR
    if (!value || !Number.isFinite(value)) return null
    return { currency, rateToEur: value, source: 'frankfurter:ecb', at: `${body.date ?? new Date().toISOString().slice(0, 10)}T00:00:00Z` }
  } catch {
    return null
  }
}
