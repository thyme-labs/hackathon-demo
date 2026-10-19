// CZK accounting legs for a payout.
//
// Czech books: Act 563/1991 Sb. s.24c(1)/s.24d(1) (wording from 1.1.2026):
// foreign-currency items are converted at the ČNB rate for the day of the
// accounting case. Practice: the liability is booked at the invoice-date rate,
// the payment at the payout-date rate, the difference is an FX gain (663) or
// loss (563). VAT (Act 235/2004 Sb. s.4(8)) uses the rate at the date the tax
// obligation arises (supply date for reverse-charged services).

import { pragueIsoDate } from './calendar';
import { type CnbOptions, type CnbRate, getRate } from './cnb';
import { EURC_DECIMALS, type InvoiceRow, type PayoutRow } from './types';

export const CZK_ACCOUNTING_RULE =
  'Act 563/1991 Sb. s.24c(1), s.24d(1): ČNB rate for the day of the accounting case; VAT Act 235/2004 Sb. s.4(8)';

/** ROUND_HALF_UP to `dp` decimals (avoids 1.005 -> 1.00 float artefacts). */
export function roundHalfUp(value: number, dp = 2): number {
  const factor = 10 ** dp;
  const scaled = Math.abs(value) * factor;
  const rounded = Math.floor(scaled + 0.5 + 1e-9);
  return (Math.sign(value) || 1) * (rounded / factor);
}

export function formatFixed(value: number | null | undefined, dp = 2): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '';
  return roundHalfUp(value, dp).toFixed(dp);
}

/** CZK amount for an EUR amount at a ČNB rate (CZK per 1 EUR), 2 dp half-up. */
export function eurToCzk(amountEur: number, czkPerEur: number): number {
  return roundHalfUp(amountEur * czkPerEur, 2);
}

/** Raw EURC units (6 dp) for a human EUR amount. */
export function toEurcRaw(amount: number): bigint {
  const [whole, frac = ''] = roundHalfUp(amount, EURC_DECIMALS).toFixed(EURC_DECIMALS).split('.');
  return BigInt(`${whole}${frac.padEnd(EURC_DECIMALS, '0')}`);
}

/** Human EURC amount from raw units. */
export function fromEurcRaw(raw: bigint | string | number): number {
  return Number(BigInt(raw)) / 10 ** EURC_DECIMALS;
}

export function formatEurc(amount: number): string {
  return roundHalfUp(amount, EURC_DECIMALS).toFixed(EURC_DECIMALS);
}

/**
 * Human EURC amount of a payout. The store convention is base units as a decimal
 * string ("1250000000"); a number or a string with a decimal point is treated as
 * human units. An integer string is cross-checked against amount_eur so a row
 * written in human units ("1250") is not misread as 0.00125 EURC.
 */
export function eurcHumanAmount(payout: Pick<PayoutRow, 'amount_eurc' | 'amount_eur'>): number {
  const raw = payout.amount_eurc;
  if (typeof raw === 'number') return raw;
  const text = raw.trim();
  if (text === '') return payout.amount_eur;
  if (text.includes('.')) return Number(text);
  if (!/^\d+$/.test(text)) return payout.amount_eur;
  const asBase = fromEurcRaw(text);
  const asHuman = Number(text);
  const ref = payout.amount_eur;
  if (ref > 0) {
    const baseErr = Math.abs(asBase - ref) / ref;
    const humanErr = Math.abs(asHuman - ref) / ref;
    return humanErr < baseErr ? asHuman : asBase;
  }
  return asBase;
}

export interface CzkLeg {
  currency: string;
  amount: number;
  /** CZK per 1 unit of `currency`. */
  rate: number;
  validFor: string;
  requestedDate: string;
  provisional: boolean;
  amountCzk: number;
  source: string;
}

export interface CzkLegs {
  /** Payment leg: EUR (EURC at par) -> CZK at the payout-date fixing. */
  payout: CzkLeg;
  /** Liability leg: invoice currency -> CZK at the invoice-date fixing (null when no invoice given). */
  invoice: CzkLeg | null;
  /** invoice.amountCzk - payout.amountCzk; positive = FX gain (663), negative = FX loss (563). */
  fxDifferenceCzk: number | null;
  fee: { feeEur: number; feeCzk: number } | null;
  rule: string;
}

function legFrom(rate: CnbRate, amount: number): CzkLeg {
  return {
    currency: rate.currency,
    amount,
    rate: rate.ratePerUnit,
    validFor: rate.validFor,
    requestedDate: rate.requestedDate,
    provisional: rate.provisional,
    amountCzk: roundHalfUp(amount * rate.ratePerUnit, 2),
    source: rate.source,
  };
}

/** Build a CnbRate from values already stored on a payout row (no network). */
export function cnbRateFromStored(ratePerUnit: number, validFor: string, requestedDate: string, currency = 'EUR'): CnbRate {
  return {
    currency,
    rate: ratePerUnit,
    amount: 1,
    ratePerUnit,
    validFor,
    requestedDate,
    expectedValidFor: validFor,
    provisional: false,
    list: 'daily',
    fetchedAt: '',
    source: 'ČNB api.cnb.cz/cnbapi/exrates/daily (stored on payout)',
    sourceUrl: '',
  };
}

export interface ComputeCzkLegsArgs {
  amountEur: number;
  eurRate: CnbRate;
  invoice?: { currency: string; amount: number; rate: CnbRate } | null;
  feeEur?: number | null;
}

/** Pure computation from already-resolved ČNB rates. */
export function computeCzkLegs(args: ComputeCzkLegsArgs): CzkLegs {
  const payout = legFrom(args.eurRate, args.amountEur);
  const invoice = args.invoice ? legFrom(args.invoice.rate, args.invoice.amount) : null;
  const fxDifferenceCzk = invoice ? roundHalfUp(invoice.amountCzk - payout.amountCzk, 2) : null;
  const fee = args.feeEur !== null && args.feeEur !== undefined ? { feeEur: args.feeEur, feeCzk: roundHalfUp(args.feeEur * args.eurRate.ratePerUnit, 2) } : null;
  return { payout, invoice, fxDifferenceCzk, fee, rule: CZK_ACCOUNTING_RULE };
}

export function payoutAccountingDate(payout: PayoutRow): string {
  const at = payout.confirmed_at ?? payout.submitted_at ?? payout.created_at;
  return at ? pragueIsoDate(at) : pragueIsoDate(new Date());
}

export interface ResolveCzkLegsOptions extends CnbOptions {
  feeEur?: number | null;
  /** Override the payout accounting date (YYYY-MM-DD, Prague). */
  payoutDate?: string;
  /** Override the invoice accounting date (defaults to invoice.issue_date, then payout date). */
  invoiceDate?: string;
  /** Prefer the rate stored on the payout row when present (default true). */
  preferStored?: boolean;
}

/** Resolve ČNB rates (payout date for EUR, invoice date for the invoice currency) and compute the legs. */
export async function resolveCzkLegs(payout: PayoutRow, invoice?: InvoiceRow | null, opts: ResolveCzkLegsOptions = {}): Promise<CzkLegs> {
  const payoutDate = opts.payoutDate ?? payoutAccountingDate(payout);
  const preferStored = opts.preferStored ?? true;
  const eurRate =
    preferStored && payout.cnb_rate && payout.cnb_valid_for
      ? cnbRateFromStored(payout.cnb_rate, payout.cnb_valid_for, payoutDate)
      : await getRate(payoutDate, 'EUR', opts);
  let invoiceLeg: ComputeCzkLegsArgs['invoice'] = null;
  if (invoice && invoice.amount !== null && invoice.amount !== undefined) {
    const currency = (invoice.currency ?? payout.currency ?? 'EUR').toUpperCase();
    const invoiceDate = opts.invoiceDate ?? invoice.issue_date ?? payoutDate;
    const rate = await getRate(invoiceDate, currency, opts);
    invoiceLeg = { currency, amount: invoice.amount, rate };
  }
  return computeCzkLegs({ amountEur: payout.amount_eur, eurRate, invoice: invoiceLeg, feeEur: opts.feeEur ?? null });
}
