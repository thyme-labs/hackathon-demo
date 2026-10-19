import lists from '../../../../config/lists.json'
import { fetchFrankfurterRate } from './frankfurter'
import { type FxQuote, fetchTatumRate } from './tatum'

export { type CnbRate, czkLeg, fetchCnbRate } from './cnb'
export type { FxQuote } from './tatum'

export interface FxResolution {
  quote: FxQuote
  /** 'live' = Tatum or Frankfurter; 'static' = dated fallback table (review required). */
  tier: 'live' | 'static'
}

const staticQuote = (currency: string): FxQuote | null => {
  const table = lists.fx_static_fallback.rates as Record<string, number>
  const rate = table[currency]
  if (!rate) return null
  return { currency, rateToEur: rate, source: `static:${lists.fx_static_fallback.source}`, at: `${lists.fx_static_fallback.as_of}T00:00:00Z` }
}

/** Mid rate currency -> EUR. Tatum first, Frankfurter second, dated static table last. */
export const resolveEurRate = async (currency: string): Promise<FxResolution | null> => {
  const code = currency.toUpperCase()
  if (code === 'EUR') {
    return { quote: { currency: 'EUR', rateToEur: 1, source: 'identity', at: new Date().toISOString() }, tier: 'live' }
  }
  const live = (await fetchTatumRate(code)) ?? (await fetchFrankfurterRate(code))
  if (live) return { quote: live, tier: 'live' }
  const fallback = staticQuote(code)
  return fallback ? { quote: fallback, tier: 'static' } : null
}
