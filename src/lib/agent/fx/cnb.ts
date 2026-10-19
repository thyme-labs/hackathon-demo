// CNB daily fixing: GET https://api.cnb.cz/cnbapi/exrates/daily?date=YYYY-MM-DD&lang=EN
// The API returns the latest published fixing when the requested day is not out yet,
// so the accounting leg always uses `validFor` from the response, not the requested date.
import { agentEnv } from '../env'

export interface CnbRate {
  currencyCode: string
  /** CZK per 1 unit of the currency (already divided by `amount`). */
  czkPerUnit: number
  validFor: string
  requestedDate: string
  source: string
}

interface CnbResponse {
  rates?: { validFor: string; amount: number; currencyCode: string; rate: number }[]
}

let memo: { key: string; value: Promise<CnbRate | null> } | null = null

export const fetchCnbRate = async (
  currencyCode = 'EUR',
  date = new Date().toISOString().slice(0, 10),
  timeoutMs = 8_000,
): Promise<CnbRate | null> => {
  const key = `${currencyCode}:${date}`
  if (memo?.key === key) return memo.value
  const value = (async (): Promise<CnbRate | null> => {
    if (agentEnv.offline()) return null
    try {
      const url = `https://api.cnb.cz/cnbapi/exrates/daily?date=${date}&lang=EN`
      const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) })
      if (!res.ok) return null
      const body = (await res.json()) as CnbResponse
      const row = body.rates?.find((r) => r.currencyCode === currencyCode)
      if (!row || !row.amount) return null
      return {
        currencyCode,
        czkPerUnit: row.rate / row.amount,
        validFor: row.validFor,
        requestedDate: date,
        source: url,
      }
    } catch {
      return null
    }
  })()
  memo = { key, value }
  return value
}

/** The CZK accounting leg for an EUR amount: amount * CNB EUR rate valid for the day. */
export const czkLeg = (amountEur: number, rate: CnbRate | null): number | null =>
  rate ? Math.round(amountEur * rate.czkPerUnit * 100) / 100 : null
