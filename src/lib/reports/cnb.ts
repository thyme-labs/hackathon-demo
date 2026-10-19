// ČNB (Czech National Bank) exchange-rate client.
//
// Daily list: GET https://api.cnb.cz/cnbapi/exrates/daily?date=YYYY-MM-DD&lang=EN
//   - keyless; returns the LAST DECLARED rates for the requested day
//     (declared every working day ~14:30 Prague; valid for that day and the
//     following Sat/Sun/public holidays). Before 14:30 the previous working
//     day's list comes back with its own `validFor`.
// Monthly "other currencies" list (UAH, GEL, RSD, ...):
//   GET https://api.cnb.cz/cnbapi/fxrates/daily-month?yearMonth=YYYY-MM&lang=EN
//   - declared on the last working day of a month, applies to the next month.
//
// Accounting rule: Act 563/1991 Sb. s.24c(1)/s.24d(1) (wording from 1.1.2026):
// convert at the ČNB rate for the day of the accounting case.

import { cnbDeclaredFor, cnbRateDayFor, parseIsoDate, pragueIsoDate, toDate } from './calendar';

export const CNB_DAILY_URL = 'https://api.cnb.cz/cnbapi/exrates/daily';
export const CNB_MONTHLY_URL = 'https://api.cnb.cz/cnbapi/fxrates/daily-month';
export const CNB_SOURCE_LABEL = 'ČNB api.cnb.cz/cnbapi/exrates/daily';
export const CNB_DECLARED_LOCAL = '14:30';

export interface CnbApiRate {
  validFor: string;
  order: number;
  country: string;
  currency: string;
  amount: number;
  currencyCode: string;
  rate: number;
}

export interface CnbRate {
  currency: string;
  /** CZK for `amount` units of the currency (ČNB quotes INR/HUF/UAH per 100, IDR per 1000). */
  rate: number;
  amount: number;
  /** CZK per 1 unit of the currency. */
  ratePerUnit: number;
  /** Day the rate is declared for (ČNB `validFor`). */
  validFor: string;
  /** The YYYY-MM-DD the caller asked for. */
  requestedDate: string;
  /** Business day whose fixing should apply to `requestedDate` (previous working day for weekends/holidays). */
  expectedValidFor: string;
  /** True when the fixing for the requested day is not declared yet (fetched before 14:30 or future date). Re-resolve later. */
  provisional: boolean;
  list: 'daily' | 'monthly' | 'fallback';
  fetchedAt: string;
  source: string;
  sourceUrl: string;
}

export interface CnbOptions {
  fetchImpl?: typeof fetch;
  /** Clock override for tests / rehearsals. */
  now?: Date;
  /** How long a provisional daily list is cached (default 5 min). Final lists are cached indefinitely. */
  provisionalTtlMs?: number;
  /** When true, a network failure returns the embedded EUR fallback instead of throwing. */
  allowFallback?: boolean;
}

export class CnbUnavailableError extends Error {
  constructor(
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'CnbUnavailableError';
  }
}

interface DailyCacheEntry {
  rates: CnbApiRate[];
  fetchedAt: number;
  final: boolean;
}

const dailyCache = new Map<string, DailyCacheEntry>();
const monthlyCache = new Map<string, { rates: CnbApiRate[]; fetchedAt: number }>();

/** Last EUR fixing seen while building (2026-10-19 14:30 Prague). Used only when `allowFallback` is set and the API is unreachable. */
export const CNB_FALLBACK_EUR: CnbApiRate = {
  validFor: '2026-10-19',
  order: 201,
  country: 'EMU',
  currency: 'euro',
  amount: 1,
  currencyCode: 'EUR',
  rate: 24.34,
};

export function clearCnbCache(): void {
  dailyCache.clear();
  monthlyCache.clear();
}

function normaliseDate(date: string | Date): string {
  if (typeof date === 'string') {
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
    return pragueIsoDate(toDate(date));
  }
  return pragueIsoDate(date);
}

async function fetchJson(url: string, fetchImpl: typeof fetch): Promise<{ rates: CnbApiRate[] }> {
  const res = await fetchImpl(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new CnbUnavailableError(`ČNB API ${res.status} for ${url}`);
  const body = (await res.json()) as { rates?: CnbApiRate[] };
  if (!Array.isArray(body.rates)) throw new CnbUnavailableError(`ČNB API returned no rates for ${url}`);
  return { rates: body.rates };
}

/** Full daily list for a date (cached; provisional lists expire after `provisionalTtlMs`). */
export async function listDailyRates(date: string | Date, opts: CnbOptions = {}): Promise<{ rates: CnbApiRate[]; fetchedAt: string }> {
  const requested = normaliseDate(date);
  const now = opts.now ?? new Date();
  const ttl = opts.provisionalTtlMs ?? 5 * 60_000;
  const cached = dailyCache.get(requested);
  if (cached && (cached.final || now.getTime() - cached.fetchedAt < ttl)) {
    return { rates: cached.rates, fetchedAt: new Date(cached.fetchedAt).toISOString() };
  }
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = `${CNB_DAILY_URL}?date=${requested}&lang=EN`;
  let rates: CnbApiRate[];
  try {
    rates = (await fetchJson(url, fetchImpl)).rates;
  } catch (err) {
    if (err instanceof CnbUnavailableError) throw err;
    throw new CnbUnavailableError(`ČNB daily list unreachable for ${requested}`, err);
  }
  const expected = cnbRateDayFor(requested);
  const validFor = rates[0]?.validFor ?? '';
  const final = validFor === expected;
  dailyCache.set(requested, { rates, fetchedAt: now.getTime(), final });
  return { rates, fetchedAt: now.toISOString() };
}

/** Monthly "other currencies" list declared for `yearMonth` (YYYY-MM). */
export async function listMonthlyRates(yearMonth: string, opts: CnbOptions = {}): Promise<{ rates: CnbApiRate[]; fetchedAt: string }> {
  const cached = monthlyCache.get(yearMonth);
  if (cached && cached.rates.length > 0) return { rates: cached.rates, fetchedAt: new Date(cached.fetchedAt).toISOString() };
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? new Date();
  const url = `${CNB_MONTHLY_URL}?yearMonth=${yearMonth}&lang=EN`;
  const { rates } = await fetchJson(url, fetchImpl);
  monthlyCache.set(yearMonth, { rates, fetchedAt: now.getTime() });
  return { rates, fetchedAt: now.toISOString() };
}

function previousYearMonth(date: string): string {
  const { year, month } = parseIsoDate(date);
  const y = month === 1 ? year - 1 : year;
  const m = month === 1 ? 12 : month - 1;
  return `${y}-${String(m).padStart(2, '0')}`;
}

function toCnbRate(row: CnbApiRate, requested: string, expected: string, list: CnbRate['list'], fetchedAt: string, sourceUrl: string): CnbRate {
  return {
    currency: row.currencyCode,
    rate: row.rate,
    amount: row.amount,
    ratePerUnit: row.rate / row.amount,
    validFor: row.validFor,
    requestedDate: requested,
    expectedValidFor: expected,
    provisional: row.validFor < expected,
    list,
    fetchedAt,
    source: list === 'monthly' ? 'ČNB api.cnb.cz/cnbapi/fxrates/daily-month' : CNB_SOURCE_LABEL,
    sourceUrl,
  };
}

/**
 * ČNB fixing of `currency` for `date` (YYYY-MM-DD or an instant, interpreted in Prague time).
 * `provisional` is true when the fixing for that day is not declared yet; store `validFor`
 * and re-resolve at ledger time. Currencies missing from the daily list fall back to the
 * monthly "other currencies" list declared for the preceding month.
 */
export async function getRate(date: string | Date, currency = 'EUR', opts: CnbOptions = {}): Promise<CnbRate> {
  const requested = normaliseDate(date);
  const expected = cnbRateDayFor(requested);
  const code = currency.toUpperCase();
  if (code === 'CZK') {
    return {
      currency: 'CZK',
      rate: 1,
      amount: 1,
      ratePerUnit: 1,
      validFor: requested,
      requestedDate: requested,
      expectedValidFor: expected,
      provisional: false,
      list: 'daily',
      fetchedAt: (opts.now ?? new Date()).toISOString(),
      source: 'identity',
      sourceUrl: '',
    };
  }
  let daily: { rates: CnbApiRate[]; fetchedAt: string };
  try {
    daily = await listDailyRates(requested, opts);
  } catch (err) {
    if (opts.allowFallback && code === 'EUR') {
      return toCnbRate(CNB_FALLBACK_EUR, requested, expected, 'fallback', (opts.now ?? new Date()).toISOString(), CNB_DAILY_URL);
    }
    throw err;
  }
  const row = daily.rates.find((r) => r.currencyCode === code);
  if (row) return toCnbRate(row, requested, expected, 'daily', daily.fetchedAt, `${CNB_DAILY_URL}?date=${requested}&lang=EN`);

  // Monthly list: try the preceding month first (declared on its last working day), then one more back.
  let yearMonth = previousYearMonth(requested);
  for (let i = 0; i < 2; i += 1) {
    const monthly = await listMonthlyRates(yearMonth, opts);
    const mrow = monthly.rates.find((r) => r.currencyCode === code);
    if (mrow) {
      const result = toCnbRate(mrow, requested, expected, 'monthly', monthly.fetchedAt, `${CNB_MONTHLY_URL}?yearMonth=${yearMonth}&lang=EN`);
      result.provisional = false; // monthly fixings are final once declared
      return result;
    }
    yearMonth = previousYearMonth(`${yearMonth}-01`);
  }
  throw new CnbUnavailableError(`ČNB has no fixing for ${code} (daily list for ${requested}, monthly lists up to ${yearMonth})`);
}

/** Convenience: EUR fixing, never throws (falls back to the embedded value and flags it). */
export async function getEurRateOrFallback(date: string | Date, opts: CnbOptions = {}): Promise<CnbRate> {
  return getRate(date, 'EUR', { ...opts, allowFallback: true });
}

/** True if the fixing for `date` should be declared by `now` (business day and past 14:30 Prague). */
export function isFixingDeclared(date: string, now = new Date()): boolean {
  return cnbDeclaredFor(date, now, CNB_DECLARED_LOCAL);
}
