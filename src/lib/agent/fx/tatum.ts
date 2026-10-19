// Tatum exchange-rate endpoint: GET /v3/tatum/rate/{currency}?basePair=EUR
// Returns the value of 1 unit of `currency` in EUR.
import { agentEnv } from '../env'

export interface FxQuote {
  currency: string
  /** EUR per 1 unit of currency. */
  rateToEur: number
  source: string
  at: string
}

export const fetchTatumRate = async (currency: string, timeoutMs = 8_000): Promise<FxQuote | null> => {
  const key = agentEnv.tatumApiKey()
  if (!key || agentEnv.offline()) return null
  try {
    const res = await fetch(`https://api.tatum.io/v3/tatum/rate/${encodeURIComponent(currency)}?basePair=EUR`, {
      headers: { 'x-api-key': key, accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return null
    const body = (await res.json()) as { value?: string | number; timestamp?: number; source?: string }
    const value = Number(body.value)
    if (!Number.isFinite(value) || value <= 0) return null
    const at = body.timestamp ? new Date(body.timestamp).toISOString() : new Date().toISOString()
    return { currency, rateToEur: value, source: `tatum:${body.source ?? 'rate'}`, at }
  } catch {
    return null
  }
}
