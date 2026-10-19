// Monthly payroll ledger: CSV (one row per payout) and a JSON export with totals.
//
// Header line (fixed order):
// date,invoice_no,beneficiary,country,currency,amount,fx_rate,amount_eur,amount_eurc,cnb_rate,amount_czk,tx_hash,executor,status,fee_eth,fee_eur
// Dates are Prague calendar dates (ISO), decimals use a dot, amounts are fixed-dp strings.

import { pragueIsoDate } from './calendar';
import { eurcHumanAmount, formatEurc, formatFixed } from './fx';
import { rails } from './rails';
import type { BeneficiaryRow, InvoiceRow, NetworkFee, PayoutRow } from './types';

export const LEDGER_COLUMNS = [
  'date',
  'invoice_no',
  'beneficiary',
  'country',
  'currency',
  'amount',
  'fx_rate',
  'amount_eur',
  'amount_eurc',
  'cnb_rate',
  'amount_czk',
  'tx_hash',
  'executor',
  'status',
  'fee_eth',
  'fee_eur',
] as const;

export type LedgerColumn = (typeof LEDGER_COLUMNS)[number];
export type LedgerRow = Record<LedgerColumn, string>;

export interface LedgerInput {
  payout: PayoutRow;
  invoice?: InvoiceRow | null;
  beneficiary?: BeneficiaryRow | null;
  fee?: NetworkFee | null;
}

/** fee in ETH from whatever the caller has (feeEth, or gasUsed x effectiveGasPrice). */
export function feeEthOf(fee: NetworkFee | null | undefined, payout?: PayoutRow): number | null {
  if (!fee) return null;
  if (fee.feeEth !== null && fee.feeEth !== undefined) return fee.feeEth;
  const gas = fee.gasUsed ?? payout?.gas_used ?? null;
  if (gas === null || fee.effectiveGasPriceWei === null || fee.effectiveGasPriceWei === undefined) return null;
  const wei = BigInt(gas) * BigInt(fee.effectiveGasPriceWei);
  return Number(wei) / 1e18;
}

export function feeEurOf(fee: NetworkFee | null | undefined, payout?: PayoutRow): number | null {
  if (!fee) return null;
  if (fee.feeEur !== null && fee.feeEur !== undefined) return fee.feeEur;
  const eth = feeEthOf(fee, payout);
  if (eth === null) return null;
  const ethEur = fee.ethEur ?? rails.eurc.ethereum.eth_eur;
  return eth * ethEur;
}

export function ledgerDate(payout: PayoutRow): string {
  const at = payout.confirmed_at ?? payout.submitted_at ?? payout.created_at;
  return at ? pragueIsoDate(at) : '';
}

export function toLedgerRow(input: LedgerInput): LedgerRow {
  const { payout, invoice, beneficiary, fee } = input;
  const feeEth = feeEthOf(fee, payout);
  const feeEur = feeEurOf(fee, payout);
  const currency = (payout.currency ?? invoice?.currency ?? 'EUR').toUpperCase();
  const amount = invoice?.amount ?? (currency === 'EUR' ? payout.amount_eur : null);
  const fxRate = payout.fx_rate ?? invoice?.fx_rate ?? (currency === 'EUR' ? 1 : null);
  return {
    date: ledgerDate(payout),
    invoice_no: invoice?.number ?? payout.invoice_id,
    beneficiary: beneficiary?.name ?? invoice?.payee_name ?? payout.beneficiary_id ?? '',
    country: beneficiary?.country ?? '',
    currency,
    amount: formatFixed(amount, 2),
    fx_rate: fxRate === null || fxRate === undefined ? '' : String(fxRate),
    amount_eur: formatFixed(payout.amount_eur, 2),
    amount_eurc: formatEurc(eurcHumanAmount(payout)),
    cnb_rate: payout.cnb_rate === null || payout.cnb_rate === undefined ? '' : String(payout.cnb_rate),
    amount_czk: formatFixed(payout.amount_czk, 2),
    tx_hash: payout.tx_hash ?? '',
    executor: payout.executor,
    status: payout.status,
    fee_eth: feeEth === null ? '' : feeEth.toFixed(18).replace(/0+$/, '').replace(/\.$/, ''),
    fee_eur: feeEur === null ? '' : formatFixed(feeEur, 6),
  };
}

function isLedgerRow(x: LedgerInput | LedgerRow): x is LedgerRow {
  return (x as LedgerInput).payout === undefined;
}

export function csvEscape(value: string): string {
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

/** RFC 4180 CSV with the fixed header line; accepts joined inputs or prebuilt rows. */
export function ledgerCsv(items: Array<LedgerInput | LedgerRow>): string {
  const rows = items.map((i) => (isLedgerRow(i) ? i : toLedgerRow(i)));
  const lines = [LEDGER_COLUMNS.join(',')];
  for (const row of rows) lines.push(LEDGER_COLUMNS.map((c) => csvEscape(row[c])).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

export interface LedgerTotals {
  count: number;
  confirmed: number;
  amount_eur: string;
  amount_eurc: string;
  amount_czk: string;
  fee_eth: string;
  fee_eur: string;
}

export interface LedgerJson {
  generated_at: string;
  period: string | null;
  columns: readonly LedgerColumn[];
  rows: LedgerRow[];
  totals: LedgerTotals;
  accounting: {
    rule: string;
    asset_account_note: string;
    vat_note: string;
  };
  sources: Array<{ label: string; url: string }>;
}

function sumOf(rows: LedgerRow[], col: LedgerColumn, onlyConfirmed = true): number {
  return rows.reduce((s, r) => {
    if (onlyConfirmed && r.status !== 'confirmed') return s;
    const v = Number(r[col]);
    return Number.isFinite(v) ? s + v : s;
  }, 0);
}

export function ledgerJson(items: Array<LedgerInput | LedgerRow>, meta: { period?: string | null; generatedAt?: Date } = {}): LedgerJson {
  const rows = items.map((i) => (isLedgerRow(i) ? i : toLedgerRow(i)));
  const confirmed = rows.filter((r) => r.status === 'confirmed').length;
  return {
    generated_at: (meta.generatedAt ?? new Date()).toISOString(),
    period: meta.period ?? null,
    columns: LEDGER_COLUMNS,
    rows,
    totals: {
      count: rows.length,
      confirmed,
      amount_eur: formatFixed(sumOf(rows, 'amount_eur'), 2),
      amount_eurc: formatEurc(sumOf(rows, 'amount_eurc')),
      amount_czk: formatFixed(sumOf(rows, 'amount_czk'), 2),
      fee_eth: sumOf(rows, 'fee_eth').toFixed(18).replace(/0+$/, '').replace(/\.$/, ''),
      fee_eur: formatFixed(sumOf(rows, 'fee_eur'), 6),
    },
    accounting: {
      rule: rails.cnb.accounting_rule,
      asset_account_note:
        'EURC held in the Safe is booked on an analytic asset account (demo: 221.900 "EURC wallet"); the MF 2018 guidance treats digital currencies as inventory "svého druhu" and predates MiCA, so the EMT treatment is an assumption.',
      vat_note: 'Services received from non-resident suppliers: reverse charge, VAT self-assessed by the recipient (Act 235/2004 Sb.); rate of the supply date.',
    },
    sources: [
      { label: 'ČNB exchange rate fixing', url: rails.cnb.source_url },
      { label: 'ESMA MiCA EMT register (EURC issuer)', url: rails.eurc.token.source_url },
    ],
  };
}
