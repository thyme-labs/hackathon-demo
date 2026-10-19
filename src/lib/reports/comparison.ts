// Dashboard card: "this month: saved EUR X and Y business days vs SWIFT",
// computed from the payouts table joined with the beneficiary country.
//
// Headline rules: fee savings are counted on non-SEPA corridors only (vs SWIFT);
// business-day savings use the realistic rail per payout (SEPA SCT for SEPA
// countries, SWIFT otherwise). The "if everything went by SWIFT" figure is kept
// for the sources drawer, clearly labelled.

import { formatPrague, pragueParts } from './calendar';
import { feeEthOf } from './ledger';
import { type ComparePayoutInput, type ComparePayoutResult, comparePayout, dedupeAssumptions, monthlySummary, rails } from './rails';
import type { Assumption, NetworkFee, PayoutRow } from './types';

export interface ComparisonPayout {
  payout: PayoutRow;
  /** Payee country (beneficiaries.country). */
  country: string;
  fee?: NetworkFee | null;
  localCurrency?: string | null;
  invoiceNumber?: string | null;
  beneficiaryName?: string | null;
}

export interface ComparisonLine {
  payoutId: string;
  invoiceId: string;
  invoiceNo: string | null;
  beneficiary: string | null;
  country: string;
  sepa: boolean;
  amountEur: number;
  status: PayoutRow['status'];
  reference: 'swift' | 'sepa';
  baselineLabel: string;
  baselineFeeEur: number;
  baselineEta: string | null;
  swiftFeeEur: number;
  swiftEta: string | null;
  eurcFeeEur: number;
  eurcSeconds: number | null;
  settledAt: string | null;
  savedEur: number;
  savedBusinessDays: number;
  txHash: string | null;
  sentence: string;
}

export interface ComparisonCard {
  period: string;
  periodLabel: string;
  vs: 'swift';
  payouts: number;
  confirmed: number;
  pending: number;
  failed: number;
  totalEur: number;
  /** Headline: fee savings vs SWIFT on non-SEPA corridors. */
  savedEur: number;
  /** Headline: business days saved vs the realistic rail per payout. */
  savedBusinessDays: number;
  savedHours: number;
  savedEurNetOfOfframp: number;
  /** Drawer: savings if every payout (incl. SEPA corridors) had gone by SWIFT. */
  savedEurIfAllSwift: number;
  savedBusinessDaysIfAllSwift: number;
  swiftCorridors: number;
  sepaCorridors: number;
  actualFeeEur: number;
  mainnetEquivalentFeeEur: number;
  avgSettlementSeconds: number | null;
  medianSettlementSeconds: number | null;
  headline: string;
  subline: string;
  lines: ComparisonLine[];
  sources: Assumption[];
  configVersion: string;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** Prague YYYY-MM the payout belongs to (confirmed_at, else submitted_at, else created_at). */
export function payoutMonth(payout: PayoutRow): string | null {
  const at = payout.confirmed_at ?? payout.submitted_at ?? payout.created_at;
  if (!at) return null;
  const p = pragueParts(at);
  return `${p.year}-${String(p.month).padStart(2, '0')}`;
}

export function currentMonth(now = new Date()): string {
  const p = pragueParts(now);
  return `${p.year}-${String(p.month).padStart(2, '0')}`;
}

function periodLabel(period: string): string {
  const [y, m] = period.split('-');
  return `${MONTHS[Number(m) - 1] ?? m} ${y}`;
}

function gasPriceGweiOf(fee: NetworkFee | null | undefined): number | null {
  if (!fee || fee.effectiveGasPriceWei === null || fee.effectiveGasPriceWei === undefined) return null;
  return Number(BigInt(fee.effectiveGasPriceWei)) / 1e9;
}

export function toCompareInput(item: ComparisonPayout, ethEur?: number | null): ComparePayoutInput | null {
  const { payout } = item;
  const submittedAt = payout.submitted_at ?? payout.created_at;
  if (!submittedAt) return null;
  const gasPriceGwei = gasPriceGweiOf(item.fee);
  const feeEth = feeEthOf(item.fee, payout);
  const gasUsed = item.fee?.gasUsed ?? payout.gas_used ?? null;
  return {
    country: item.country,
    amountEur: payout.amount_eur,
    actualGasUsed: gasUsed,
    gasPriceGwei: gasPriceGwei ?? (feeEth !== null && gasUsed ? (feeEth * 1e9) / gasUsed : null),
    ethEur: item.fee?.ethEur ?? ethEur ?? null,
    submittedAt,
    confirmedAt: payout.confirmed_at ?? null,
    localCurrency: item.localCurrency,
  };
}

export function fmtEur(n: number): string {
  const dp = Number.isInteger(n) ? 0 : 2;
  return `€${n.toLocaleString('en-GB', { minimumFractionDigits: dp, maximumFractionDigits: 2 })}`;
}

function fmtDays(n: number): string {
  return n.toLocaleString('en-GB', { maximumFractionDigits: 1 });
}

function fmtSeconds(s: number | null): string {
  if (s === null) return 'pending';
  if (s < 90) return `${Math.round(s)} s`;
  return `${Math.round(s / 60)} min`;
}

function receiptSentence(r: ComparePayoutResult, baseline: ComparePayoutResult['baselines']['swift'] | ComparePayoutResult['baselines']['sepa']): string {
  const rail = baseline.rail === 'swift' ? 'SWIFT' : 'SEPA';
  const landed = baseline.etaLabel ? ` and landed ${baseline.etaLabel}` : '';
  const settled = r.actual.confirmedAt ? ` (${formatPrague(r.actual.confirmedAt)})` : '';
  const eurcFee = r.actual.mainnetEquivalentFeeEur < 0.01 ? '< €0.01' : fmtEur(r.actual.mainnetEquivalentFeeEur);
  return `${rail} would have cost ${fmtEur(baseline.feeEur)}${landed}; EURC cost ${eurcFee} at mainnet prices and settled in ${fmtSeconds(r.actual.seconds)}${settled}.`;
}

export interface ComparisonOptions {
  /** YYYY-MM (Prague); defaults to the current month. */
  month?: string;
  now?: Date;
  /** Live ETH/EUR for the mainnet-equivalent fee; defaults to the config snapshot. */
  ethEur?: number | null;
  /** Include submitted-but-unconfirmed payouts (estimated inclusion). Default false. */
  includePending?: boolean;
}

export function buildComparisonCard(items: ComparisonPayout[], opts: ComparisonOptions = {}): ComparisonCard {
  const period = opts.month ?? currentMonth(opts.now);
  const inPeriod = items.filter((i) => payoutMonth(i.payout) === period);
  const confirmed = inPeriod.filter((i) => i.payout.status === 'confirmed');
  const pending = inPeriod.filter((i) => i.payout.status === 'submitted' || i.payout.status === 'pending');
  const failed = inPeriod.filter((i) => i.payout.status === 'failed' || i.payout.status === 'reverted');
  const counted = opts.includePending ? [...confirmed, ...pending] : confirmed;

  const lines: ComparisonLine[] = [];
  const results: ComparePayoutResult[] = [];
  for (const item of counted) {
    const input = toCompareInput(item, opts.ethEur);
    if (!input) continue;
    const r = comparePayout(input);
    results.push(r);
    const baseline = r.reference === 'sepa' ? r.baselines.sepa : r.baselines.swift;
    lines.push({
      payoutId: item.payout.id,
      invoiceId: item.payout.invoice_id,
      invoiceNo: item.invoiceNumber ?? null,
      beneficiary: item.beneficiaryName ?? null,
      country: r.country,
      sepa: r.sepa,
      amountEur: r.amountEur,
      status: item.payout.status,
      reference: r.reference,
      baselineLabel: baseline.label,
      baselineFeeEur: baseline.feeEur,
      baselineEta: baseline.etaLabel,
      swiftFeeEur: r.baselines.swift.feeEur,
      swiftEta: r.baselines.swift.etaLabel,
      eurcFeeEur: r.actual.mainnetEquivalentFeeEur,
      eurcSeconds: r.actual.seconds,
      settledAt: r.actual.confirmedAt,
      savedEur: r.sepa ? 0 : r.savedEurVsSwift,
      savedBusinessDays: r.savedBusinessDays,
      txHash: item.payout.tx_hash ?? null,
      sentence: receiptSentence(r, baseline),
    });
  }

  const summary = monthlySummary(results);
  const savedEur = summary.savedEurSwiftCorridors;
  const savedDays = summary.savedBusinessDays;

  let headline: string;
  let subline: string;
  if (results.length === 0) {
    headline = `No payouts in ${periodLabel(period)} yet`;
    subline = 'Savings vs SWIFT appear here after the first confirmed payout.';
  } else if (summary.swiftCorridorCount > 0) {
    headline = `This month: ${fmtEur(savedEur)} and ${fmtDays(savedDays)} business days saved vs SWIFT`;
    subline = summary.sepaCorridorCount > 0
      ? `${summary.swiftCorridorCount} non-SEPA payout(s) counted for fees; ${summary.sepaCorridorCount} SEPA payout(s) counted for time only (SEPA is free at Czech banks).`
      : `${summary.swiftCorridorCount} payout(s) to non-SEPA countries; EURC fee at mainnet prices ${fmtEur(summary.mainnetEquivalentFeeEur)}.`;
  } else {
    headline = `This month: ${fmtDays(savedDays)} business days saved vs SEPA`;
    subline = 'All payees are SEPA-reachable: fee parity with SEPA (EUR 0-0.25), the gain is time and 24/7 settlement.';
  }

  return {
    period,
    periodLabel: periodLabel(period),
    vs: 'swift',
    payouts: inPeriod.length,
    confirmed: confirmed.length,
    pending: pending.length,
    failed: failed.length,
    totalEur: summary.totalEur,
    savedEur,
    savedBusinessDays: savedDays,
    savedHours: summary.savedHours,
    savedEurNetOfOfframp: summary.savedEurNetOfOfframp,
    savedEurIfAllSwift: summary.savedEurVsSwift,
    savedBusinessDaysIfAllSwift: summary.savedBusinessDaysVsSwift,
    swiftCorridors: summary.swiftCorridorCount,
    sepaCorridors: summary.sepaCorridorCount,
    actualFeeEur: summary.actualFeeEur,
    mainnetEquivalentFeeEur: summary.mainnetEquivalentFeeEur,
    avgSettlementSeconds: summary.avgSettlementSeconds,
    medianSettlementSeconds: summary.medianSettlementSeconds,
    headline,
    subline,
    lines,
    sources: dedupeAssumptions(summary.assumptions),
    configVersion: rails.version,
  };
}

/** Flat list for the "Assumptions and sources" drawer, independent of any payout. */
export function staticSources(): Assumption[] {
  const s = rails.swift;
  const list: Assumption[] = [];
  for (const [id, bank] of Object.entries(s.banks)) {
    list.push({ key: `swift.bank.${id}`, label: `SWIFT sender fee, ${bank.label}`, value: bank.rule.kind === 'flat' ? `${bank.rule.fee_czk} CZK` : `${bank.rule.pct} %, min ${bank.rule.min_czk}, max ${bank.rule.max_czk} CZK`, source_url: bank.source_url, fetched_on: bank.fetched_on, note: bank.note });
  }
  list.push({ key: 'swift.correspondent', label: 'Correspondent deductions', value: `USD ${s.correspondent_deduction.usd_low}-${s.correspondent_deduction.usd_high} per transfer`, source_url: s.correspondent_deduction.source_url, fetched_on: s.correspondent_deduction.fetched_on, note: s.correspondent_deduction.note });
  list.push({ key: 'swift.time', label: 'SWIFT gpi end-to-end time', value: `median ${s.time.overall_median_h} h, mean ${s.time.overall_mean_h} h`, source_url: s.time.source_url, fetched_on: s.time.fetched_on, note: s.time.note });
  list.push({ key: 'sepa.reach', label: 'SEPA scheme countries', value: `${rails.sepa.countries.length} countries (EPC409-09 v8.0)`, source_url: rails.sepa.source_url, fetched_on: rails.sepa.fetched_on, note: rails.sepa.note });
  list.push({ key: 'sepa.time', label: 'SEPA SCT / Instant', value: `SCT D+1 max; Instant ${rails.sepa.instant.seconds} s (CZ send from ${rails.sepa.instant.cz_send_mandatory_from})`, source_url: rails.sepa.instant.source_url, fetched_on: rails.sepa.instant.fetched_on, note: rails.sepa.instant.note });
  const e = rails.eurc.ethereum;
  list.push({ key: 'eurc.mainnet_gas', label: 'Ethereum mainnet gas snapshot', value: `base fee ${e.basefee_gwei} gwei, tip p50 ${e.tip_p50_gwei} / p90 ${e.tip_p90_gwei}; ETH ${e.eth_eur} EUR`, source_url: e.fee_source_url, fetched_on: e.fee_fetched_at, note: e.note });
  list.push({ key: 'eurc.base', label: 'Base L2 reference', value: `${rails.eurc.base.gas_price_gwei} gwei, ~EUR ${rails.eurc.base.cost_eur_plain}`, source_url: rails.eurc.base.source_url, fetched_on: rails.eurc.base.fetched_on, note: rails.eurc.base.note });
  list.push({ key: 'eurc.offramp', label: 'Payee off-ramp', value: `Kraken SEPA EUR ${rails.eurc.offramp.kraken_sepa_eur} / instant EUR ${rails.eurc.offramp.kraken_sepa_instant_eur}; P2P spreads per country`, source_url: rails.eurc.offramp.source_url, fetched_on: rails.eurc.offramp.fetched_on, note: rails.eurc.offramp.note });
  list.push({ key: 'fx.reference', label: 'ECB reference rates used for CZK tariffs', value: `EUR/CZK ${rails.fx_reference.rates.CZK} (${rails.fx_reference.date})`, source_url: rails.fx_reference.source_url, fetched_on: rails.fx_reference.fetched_on, note: rails.fx_reference.note });
  list.push({ key: 'cnb', label: 'ČNB fixing for the accounting leg', value: `declared ~${rails.cnb.declared_local_time} on working days`, source_url: rails.cnb.source_url, fetched_on: rails.cnb.fetched_on, note: rails.cnb.note });
  return list;
}
