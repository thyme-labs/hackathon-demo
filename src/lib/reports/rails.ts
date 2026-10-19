// Payout comparison against SWIFT / SEPA / Wise, driven by config/rails.json.
//
// Honesty rules baked in (see research notes behind config/rails.json):
//  - For SEPA-reachable payees (EU/EEA, UK, Serbia) a Czech company already pays
//    EUR 0-0.25 per transfer, so the saving there is TIME and 24/7 availability,
//    not fees. The reference rail is SEPA for those countries, SWIFT otherwise.
//  - Sepolia gas is ~0; `savedEur` therefore uses the MAINNET-EQUIVALENT fee
//    (gasUsed x snapshot gas price x ETH/EUR) so the number survives "testnet is free".
//  - Baseline times are business-day aware (Prague calendar, bank cut-offs).

import railsJson from '../../../config/rails.json';
import {
  addHours,
  atPragueTime,
  businessDaysBetween,
  formatPrague,
  nextBusinessDay,
  rollToBusinessDay,
  toDate,
  valueDateFor,
} from './calendar';
import type { Assumption } from './types';

// ---------- config types ----------

export interface Sourced {
  source_url: string;
  fetched_on: string;
  note?: string;
}

export type FeeRule =
  | { kind: 'pct'; pct: number; min_czk: number; max_czk: number; flat_below_czk?: number; flat_fee_czk?: number; our_surcharge_czk?: number }
  | { kind: 'flat'; fee_czk: number };

export type SwiftBankId = 'CSOB' | 'KB' | 'Fio' | 'RB';
export type SepaBankId = 'CSOB' | 'KB' | 'Fio' | 'RB';
export type ChargeOption = 'SHA' | 'OUR';

export interface SwiftBank extends Sourced {
  label: string;
  rule: FeeRule;
  d_plus_1_non_eea: boolean;
  cutoff_local: string;
}

export interface ReceiverSide extends Sourced {
  fee_eur: number;
  fx_margin_pct: number;
  fx_margin_range_pct?: number[];
  verified: boolean;
}

export interface WiseQuote extends Sourced {
  fee_eur: number;
  fee_eur_bank_funded: number | null;
  hours: number;
  verified: boolean;
}

export interface RailsConfig {
  version: string;
  fx_reference: Sourced & { base: string; date: string; rates: { CZK: number; USD: number; GBP: number; INR: number } };
  sepa: Sourced & {
    countries: string[];
    eea_countries: string[];
    reach_notes: Record<string, string>;
    sct: Sourced & {
      default_bank: SepaBankId;
      banks: Record<SepaBankId, Sourced & { fee_czk: number }>;
      cutoff_local: string;
      credit_rule: string;
      credit_local_time: string;
      business_days_only: boolean;
    };
    instant: Sourced & {
      fee_czk: number;
      seconds: number;
      availability: string;
      cz_receive_mandatory_from: string;
      cz_send_mandatory_from: string;
      cz_banks_sending_today: string[];
      fio_cap_eur_per_tx: number;
    };
    receiver_fx_margin_pct: Record<string, Sourced & { value: number; applies_when: string }>;
  };
  swift: {
    default_bank: SwiftBankId;
    charge_option: ChargeOption;
    banks: Record<SwiftBankId, SwiftBank>;
    correspondent_deduction: Sourced & { usd_low: number; usd_high: number; default_eur: number; eur_low: number; eur_high: number };
    receiver: Record<string, ReceiverSide>;
    time: Sourced & {
      overall_median_h: number;
      overall_mean_h: number;
      region_median_h: Record<string, number>;
      country_region: Record<string, string>;
      to_bank_within_1h_pct: number;
      to_customer_within_1h_pct: number;
      release_local_time_d0: string;
      release_local_time_d1: string;
      business_days_only: boolean;
      model: string;
    };
  };
  wise: { quote_amount_eur: number; quotes: Record<string, WiseQuote>; availability: string; scaling: string; fetched_on: string };
  platforms: Record<string, Sourced & Record<string, unknown>>;
  eurc: {
    token: Sourced & { symbol: string; issuer: string; issuer_lei: string; dti: string; sepolia_address: string; decimals: number };
    ethereum: Sourced & {
      gas_plain_transfer_new_recipient: number;
      gas_plain_transfer_existing_recipient: number;
      gas_roles_path_range: number[];
      gas_budget_roles_path: number;
      basefee_gwei: number;
      basefee_gwei_range: number[];
      tip_p50_gwei: number;
      tip_p90_gwei: number;
      equivalent_gas_price_gwei: number;
      eth_eur: number;
      eth_usd: number;
      price_source_url: string;
      price_fetched_at: string;
      fee_source_url: string;
      fee_fetched_at: string;
      cost_eur_plain_range: number[];
      cost_eur_roles_range: number[];
      inclusion_seconds: number;
      finality_minutes_range: number[];
      availability: string;
    };
    base: Sourced & { gas_price_gwei: number; cost_eur_plain: number; block_seconds: number; l1_withdrawal_window_days: number };
    offramp: Sourced & {
      default_fee_pct: number;
      default_fixed_eur: number;
      kraken_sepa_eur: number;
      kraken_sepa_instant_eur: number;
      kraken_sepa_business_days: number[];
      p2p_spread_pct: Record<string, number[]>;
      country_note: Record<string, string>;
    };
    travel_rule: Sourced & { self_hosted_threshold_eur: number };
  };
  local_currency: Record<string, string>;
  cnb: Sourced & { daily_url: string; monthly_url: string; declared_local_time: string; accounting_rule: string };
}

export const rails: RailsConfig = railsJson as unknown as RailsConfig;

/** Cheap shape check so a broken config fails loudly at startup rather than in a report. */
export function assertRailsConfig(cfg: RailsConfig = rails): void {
  const bank = cfg.swift.banks[cfg.swift.default_bank];
  if (!bank) throw new Error(`rails.json: default SWIFT bank ${cfg.swift.default_bank} missing`);
  if (bank.rule.kind !== 'pct' && bank.rule.kind !== 'flat') throw new Error('rails.json: bad fee rule kind');
  if (!cfg.sepa.sct.banks[cfg.sepa.sct.default_bank]) throw new Error('rails.json: default SEPA bank missing');
  if (!(cfg.fx_reference.rates.CZK > 0)) throw new Error('rails.json: fx_reference.rates.CZK missing');
  if (!(cfg.eurc.ethereum.eth_eur > 0)) throw new Error('rails.json: eurc.ethereum.eth_eur missing');
}

// ---------- helpers ----------

export function isSepaCountry(country: string): boolean {
  return rails.sepa.countries.includes(country.toUpperCase());
}

export function isEeaCountry(country: string): boolean {
  return rails.sepa.eea_countries.includes(country.toUpperCase());
}

export function localCurrencyOf(country: string): string | null {
  return rails.local_currency[country.toUpperCase()] ?? null;
}

export function czkToEur(czk: number): number {
  return czk / rails.fx_reference.rates.CZK;
}

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function round4(n: number): number {
  return Math.round((n + Number.EPSILON) * 10_000) / 10_000;
}

/** Sender-side SWIFT fee in CZK for a given bank tariff. */
export function swiftSenderFeeCzk(amountCzk: number, rule: FeeRule, chargeOption: ChargeOption, nonEea: boolean): { fee: number; surcharge: number } {
  if (rule.kind === 'flat') return { fee: rule.fee_czk, surcharge: 0 };
  let fee: number;
  if (rule.flat_below_czk !== undefined && rule.flat_fee_czk !== undefined && amountCzk <= rule.flat_below_czk) {
    fee = rule.flat_fee_czk;
  } else {
    fee = Math.min(Math.max((rule.pct / 100) * amountCzk, rule.min_czk), rule.max_czk);
  }
  const surcharge = chargeOption === 'OUR' && nonEea && rule.our_surcharge_czk ? rule.our_surcharge_czk : 0;
  return { fee, surcharge };
}

function assumption(key: string, label: string, value: string, src: Sourced): Assumption {
  return { key, label, value, source_url: src.source_url, fetched_on: src.fetched_on, note: src.note };
}

export function dedupeAssumptions(list: Assumption[]): Assumption[] {
  const seen = new Map<string, Assumption>();
  for (const a of list) if (!seen.has(a.key)) seen.set(a.key, a);
  return [...seen.values()];
}

// ---------- public types ----------

export interface ComparePayoutInput {
  /** Payee country, ISO-3166 alpha-2. */
  country: string;
  amountEur: number;
  /** gasUsed from the receipt (null while pending). */
  actualGasUsed?: number | null;
  /** effectiveGasPrice from the receipt, in gwei (Sepolia: ~0.000000016). */
  gasPriceGwei?: number | null;
  /** ETH/EUR at payout time (Chainlink or CoinGecko); defaults to the config snapshot. */
  ethEur?: number | null;
  submittedAt: string | number | Date;
  confirmedAt?: string | number | Date | null;
  /** Override the sender bank tariff used for the SWIFT baseline (default CSOB). */
  bank?: SwiftBankId;
  sepaBank?: SepaBankId;
  chargeOption?: ChargeOption;
  /** Payee's local currency (Wise quote + receiver FX margin); defaults from config.local_currency. */
  localCurrency?: string | null;
  /** Mainnet gas price used for the "if this ran on mainnet" fee (gwei); defaults to config snapshot. */
  mainnetGasPriceGwei?: number | null;
}

export interface FeeLine {
  label: string;
  eur: number;
  /** Not counted in `feeEur` (e.g. receiver FX margin that only applies if the payee auto-converts). */
  conditional?: boolean;
}

export interface RailBaseline {
  rail: 'swift' | 'sepa' | 'wise';
  label: string;
  available: boolean;
  feeEur: number;
  /** feeEur plus conditional lines. */
  feeEurIncludingConditional: number;
  feeBreakdown: FeeLine[];
  etaAt: string | null;
  etaLabel: string | null;
  hours: number | null;
  /** Prague business days from submission to credit. */
  businessDays: number | null;
  availability: string;
  note: string;
}

export interface ActualRail {
  rail: 'eurc';
  label: string;
  chain: string;
  gasUsed: number | null;
  gasPriceGwei: number | null;
  feeEth: number | null;
  /** Fee actually paid (Sepolia: effectively 0). */
  feeEur: number | null;
  ethEur: number;
  mainnetEquivalentGasPriceGwei: number;
  /** gasUsed (or the 150k budget while pending) x mainnet gas price x ETH/EUR. */
  mainnetEquivalentFeeEur: number;
  /** Execution fee on Base at the snapshot gas price (L1 data fee excluded; config quotes ~EUR 0.001 all-in). */
  baseEquivalentFeeEur: number;
  seconds: number | null;
  confirmedAt: string | null;
  /** True when `confirmedAt` is missing and the inclusion time is assumed. */
  estimated: boolean;
  businessDays: number;
  availability: string;
  /** Payee off-ramp estimate (config default 0 %, labelled); shown as its own line. */
  payeeOfframpEstimateEur: number;
  offrampNote: string | null;
  travelRuleNote: string | null;
  note: string;
}

export interface ComparePayoutResult {
  country: string;
  sepa: boolean;
  eea: boolean;
  localCurrency: string | null;
  amountEur: number;
  submittedAt: string;
  baselines: { swift: RailBaseline; sepa: RailBaseline; wise: RailBaseline };
  actual: ActualRail;
  /** Realistic rail the payee would otherwise be paid by. */
  reference: 'swift' | 'sepa';
  /** Reference fee minus the mainnet-equivalent EURC fee. */
  savedEur: number;
  /** Reference fee minus EURC fee minus the payee off-ramp estimate. */
  savedEurNetOfOfframp: number;
  savedBusinessDays: number;
  savedHours: number;
  savedEurVsSwift: number;
  savedBusinessDaysVsSwift: number;
  assumptionsUsed: Assumption[];
}

// ---------- baselines ----------

function swiftBaseline(input: ComparePayoutInput, submittedAt: Date, country: string, nonEea: boolean, used: Assumption[]): RailBaseline {
  const bankId = input.bank ?? rails.swift.default_bank;
  const bank = rails.swift.banks[bankId];
  const chargeOption = input.chargeOption ?? rails.swift.charge_option;
  const czkPerEur = rails.fx_reference.rates.CZK;
  const amountCzk = input.amountEur * czkPerEur;
  const sender = swiftSenderFeeCzk(amountCzk, bank.rule, chargeOption, nonEea);
  const receiver = rails.swift.receiver[country] ?? rails.swift.receiver.default;
  const correspondentEur = chargeOption === 'OUR' && sender.surcharge > 0 ? 0 : rails.swift.correspondent_deduction.default_eur;
  const lines: FeeLine[] = [
    { label: `${bank.label} outgoing fee (${chargeOption})`, eur: round2(czkToEur(sender.fee)) },
  ];
  if (sender.surcharge > 0) lines.push({ label: 'OUR surcharge', eur: round2(czkToEur(sender.surcharge)) });
  if (correspondentEur > 0) lines.push({ label: 'Correspondent deductions (Wise estimate USD 15-50)', eur: round2(correspondentEur) });
  if (receiver && receiver.fee_eur > 0) lines.push({ label: `Receiving bank fee (${country})`, eur: round2(receiver.fee_eur) });
  if (receiver && receiver.fx_margin_pct > 0) {
    lines.push({ label: `Receiving bank FX margin ${receiver.fx_margin_pct} % (${country})`, eur: round2((receiver.fx_margin_pct / 100) * input.amountEur) });
  }
  const feeEur = round2(lines.reduce((s, l) => s + (l.conditional ? 0 : l.eur), 0));

  // Time model (see config.swift.time.model).
  const valueDate = valueDateFor(submittedAt, bank.cutoff_local);
  const dPlusOne = bank.d_plus_1_non_eea && nonEea;
  const releaseAt = dPlusOne
    ? atPragueTime(nextBusinessDay(valueDate), rails.swift.time.release_local_time_d1)
    : atPragueTime(valueDate, rails.swift.time.release_local_time_d0);
  const region = rails.swift.time.country_region[country] ?? 'default';
  const medianHours = rails.swift.time.region_median_h[region] ?? rails.swift.time.overall_median_h;
  const creditAt = rollToBusinessDay(addHours(releaseAt, medianHours));
  const hours = (creditAt.getTime() - submittedAt.getTime()) / 3_600_000;

  used.push(assumption(`swift.bank.${bankId}`, `SWIFT sender fee, ${bank.label}`, describeRule(bank.rule), bank));
  used.push(assumption('swift.correspondent', 'Correspondent deductions', `EUR ${rails.swift.correspondent_deduction.default_eur} (range ${rails.swift.correspondent_deduction.eur_low}-${rails.swift.correspondent_deduction.eur_high})`, rails.swift.correspondent_deduction));
  if (receiver && (receiver.fee_eur > 0 || receiver.fx_margin_pct > 0)) {
    used.push(assumption(`swift.receiver.${country}`, `Receiving side (${country})`, `EUR ${receiver.fee_eur} + ${receiver.fx_margin_pct} % FX${receiver.verified ? '' : ' (unverified)'}`, receiver));
  }
  used.push(assumption('swift.time', 'SWIFT end-to-end time', `median ${medianHours} h for region "${region}" (BIS CPMI 2022); cut-off ${bank.cutoff_local}${dPlusOne ? ', non-EEA credited D+1' : ''}`, rails.swift.time));

  return {
    rail: 'swift',
    label: `SWIFT via ${bank.label}`,
    available: true,
    feeEur,
    feeEurIncludingConditional: feeEur,
    feeBreakdown: lines,
    etaAt: creditAt.toISOString(),
    etaLabel: formatPrague(creditAt),
    hours: round4(hours),
    businessDays: round4(businessDaysBetween(submittedAt, creditAt)),
    availability: `Mon-Fri, cut-off ${bank.cutoff_local} Prague`,
    note: `Value date ${valueDate}${dPlusOne ? ' (non-EEA: credited D+1)' : ''}; release ${formatPrague(releaseAt)}; + BIS median ${medianHours} h; only ${rails.swift.time.to_customer_within_1h_pct} % of gpi payments reach the end customer within 1 h.`,
  };
}

function describeRule(rule: FeeRule): string {
  if (rule.kind === 'flat') return `${rule.fee_czk} CZK flat`;
  const flat = rule.flat_below_czk !== undefined ? `${rule.flat_fee_czk} CZK up to ${rule.flat_below_czk} CZK; above ` : '';
  const our = rule.our_surcharge_czk ? `; OUR +${rule.our_surcharge_czk} CZK` : '';
  return `${flat}${rule.pct} %, min ${rule.min_czk}, max ${rule.max_czk} CZK${our}`;
}

function sepaBaseline(input: ComparePayoutInput, submittedAt: Date, country: string, localCurrency: string | null, used: Assumption[]): RailBaseline {
  const available = isSepaCountry(country);
  const bankId = input.sepaBank ?? rails.sepa.sct.default_bank;
  const bank = rails.sepa.sct.banks[bankId];
  const instant = rails.sepa.instant;
  if (!available) {
    used.push(assumption('sepa.reach', 'SEPA reach', `${country} is not a SEPA scheme country`, rails.sepa));
    return {
      rail: 'sepa',
      label: 'SEPA credit transfer',
      available: false,
      feeEur: 0,
      feeEurIncludingConditional: 0,
      feeBreakdown: [],
      etaAt: null,
      etaLabel: null,
      hours: null,
      businessDays: null,
      availability: 'not reachable',
      note: rails.sepa.reach_notes[country] ?? `${country} is not in the EPC list of SEPA scheme countries (v8.0, Dec 2025).`,
    };
  }
  const lines: FeeLine[] = [{ label: `${bankId} SEPA fee`, eur: round2(czkToEur(bank.fee_czk)) }];
  const fxMargin = rails.sepa.receiver_fx_margin_pct[country];
  if (fxMargin && localCurrency && localCurrency !== 'EUR') {
    lines.push({ label: `Receiving bank FX ${fxMargin.value} % (${fxMargin.applies_when})`, eur: round2((fxMargin.value / 100) * input.amountEur), conditional: true });
    used.push(assumption(`sepa.fx.${country}`, `Receiver FX margin (${country})`, `${fxMargin.value} %, ${fxMargin.applies_when}`, fxMargin));
  }
  const feeEur = round2(lines.reduce((s, l) => s + (l.conditional ? 0 : l.eur), 0));
  const feeAll = round2(lines.reduce((s, l) => s + l.eur, 0));

  const valueDate = valueDateFor(submittedAt, rails.sepa.sct.cutoff_local);
  const creditAt = atPragueTime(nextBusinessDay(valueDate), rails.sepa.sct.credit_local_time);
  const hours = (creditAt.getTime() - submittedAt.getTime()) / 3_600_000;

  used.push(assumption('sepa.reach', 'SEPA reach', `${country} is a SEPA scheme country`, rails.sepa));
  used.push(assumption(`sepa.bank.${bankId}`, `SEPA fee, ${bankId}`, `${bank.fee_czk} CZK`, bank));
  used.push(assumption('sepa.time', 'SEPA SCT time', `credit by end of next business day (PSD2 Art. 83(1)); cut-off ${rails.sepa.sct.cutoff_local}`, rails.sepa.sct));
  used.push(assumption('sepa.instant', 'SEPA Instant', `${instant.seconds} s, 24/7, but Czech PSPs must send only from ${instant.cz_send_mandatory_from}`, instant));

  return {
    rail: 'sepa',
    label: 'SEPA credit transfer',
    available: true,
    feeEur,
    feeEurIncludingConditional: feeAll,
    feeBreakdown: lines,
    etaAt: creditAt.toISOString(),
    etaLabel: formatPrague(creditAt),
    hours: round4(hours),
    businessDays: round4(businessDaysBetween(submittedAt, creditAt)),
    availability: 'business days',
    note: `Value date ${valueDate}; ${rails.sepa.sct.credit_rule} SEPA Instant (${instant.seconds} s, 24/7) is sent today only by ${instant.cz_banks_sending_today.join('/')}; mandatory for Czech banks from ${instant.cz_send_mandatory_from}. ${rails.sepa.reach_notes[country] ?? ''}`.trim(),
  };
}

function wiseBaseline(input: ComparePayoutInput, submittedAt: Date, localCurrency: string | null, used: Assumption[]): RailBaseline {
  const quote = localCurrency ? rails.wise.quotes[localCurrency] : undefined;
  if (!quote || !localCurrency) {
    return {
      rail: 'wise',
      label: 'Wise Business',
      available: false,
      feeEur: 0,
      feeEurIncludingConditional: 0,
      feeBreakdown: [],
      etaAt: null,
      etaLabel: null,
      hours: null,
      businessDays: null,
      availability: rails.wise.availability,
      note: localCurrency ? `No Wise quote on file for ${localCurrency}.` : 'Local currency unknown; no Wise quote.',
    };
  }
  const feeEur = round2((quote.fee_eur * input.amountEur) / rails.wise.quote_amount_eur);
  const etaAt = addHours(submittedAt, quote.hours);
  used.push(assumption(`wise.${localCurrency}`, `Wise quote EUR -> ${localCurrency}`, `EUR ${quote.fee_eur} per EUR ${rails.wise.quote_amount_eur}, ~${quote.hours} h${quote.verified ? '' : ' (unverified)'}`, quote));
  return {
    rail: 'wise',
    label: `Wise Business (EUR -> ${localCurrency})`,
    available: true,
    feeEur,
    feeEurIncludingConditional: feeEur,
    feeBreakdown: [{ label: `Wise fee, ${rails.wise.scaling}`, eur: feeEur }],
    etaAt: etaAt.toISOString(),
    etaLabel: formatPrague(etaAt),
    hours: quote.hours,
    businessDays: round4(businessDaysBetween(submittedAt, etaAt)),
    availability: rails.wise.availability,
    note: quote.note ?? '',
  };
}

function actualRail(input: ComparePayoutInput, submittedAt: Date, country: string, used: Assumption[]): ActualRail {
  const eth = rails.eurc.ethereum;
  const ethEur = input.ethEur && input.ethEur > 0 ? input.ethEur : eth.eth_eur;
  const gasUsed = input.actualGasUsed ?? null;
  const gasPriceGwei = input.gasPriceGwei ?? null;
  const feeEth = gasUsed !== null && gasPriceGwei !== null ? gasUsed * gasPriceGwei * 1e-9 : null;
  const feeEur = feeEth !== null ? feeEth * ethEur : null;
  const mainnetGwei = input.mainnetGasPriceGwei && input.mainnetGasPriceGwei > 0 ? input.mainnetGasPriceGwei : eth.equivalent_gas_price_gwei;
  const gasForEquivalent = gasUsed ?? eth.gas_budget_roles_path;
  const mainnetEquivalentFeeEur = round4(gasForEquivalent * mainnetGwei * 1e-9 * ethEur);
  const baseEquivalentFeeEur = round4(gasForEquivalent * rails.eurc.base.gas_price_gwei * 1e-9 * ethEur);

  const confirmed = input.confirmedAt ? toDate(input.confirmedAt) : null;
  const estimated = confirmed === null;
  const settledAt = confirmed ?? new Date(submittedAt.getTime() + eth.inclusion_seconds * 1000);
  const seconds = (settledAt.getTime() - submittedAt.getTime()) / 1000;

  const offramp = rails.eurc.offramp;
  const payeeOfframpEstimateEur = round2((offramp.default_fee_pct / 100) * input.amountEur + offramp.default_fixed_eur);
  const travel = rails.eurc.travel_rule;
  const travelRuleNote = input.amountEur > travel.self_hosted_threshold_eur
    ? `Above EUR ${travel.self_hosted_threshold_eur}: the payee's off-ramp CASP must verify ownership of a self-hosted wallet (Reg. (EU) 2023/1113 Art. 14(5), 16(2)).`
    : null;

  used.push(assumption('eurc.mainnet_gas', 'Mainnet-equivalent gas price', `${mainnetGwei} gwei (base fee ${eth.basefee_gwei} + p50 tip ${eth.tip_p50_gwei}; p90 tip ${eth.tip_p90_gwei})`, { source_url: eth.fee_source_url, fetched_on: eth.fee_fetched_at, note: eth.note }));
  used.push(assumption('eurc.eth_eur', 'ETH/EUR', `${ethEur}${input.ethEur ? ' (live)' : ' (snapshot)'}`, { source_url: eth.price_source_url, fetched_on: eth.price_fetched_at }));
  used.push(assumption('eurc.time', 'Ethereum inclusion / finality', `~${eth.inclusion_seconds} s inclusion, ${eth.finality_minutes_range[0]}-${eth.finality_minutes_range[1]} min finality, ${eth.availability}`, eth));
  used.push(assumption('eurc.base', 'Base L2 reference', `${rails.eurc.base.gas_price_gwei} gwei, ~EUR ${rails.eurc.base.cost_eur_plain} per transfer`, rails.eurc.base));
  used.push(assumption('eurc.offramp', 'Payee off-ramp', `${offramp.default_fee_pct} % + EUR ${offramp.default_fixed_eur} (default); Kraken SEPA EUR ${offramp.kraken_sepa_eur}, instant EUR ${offramp.kraken_sepa_instant_eur}`, offramp));

  return {
    rail: 'eurc',
    label: 'EURC on Ethereum (Safe + Roles)',
    chain: 'ethereum-sepolia',
    gasUsed,
    gasPriceGwei,
    feeEth,
    feeEur: feeEur !== null ? round4(feeEur) : null,
    ethEur,
    mainnetEquivalentGasPriceGwei: mainnetGwei,
    mainnetEquivalentFeeEur,
    baseEquivalentFeeEur,
    seconds: estimated ? null : round4(seconds),
    confirmedAt: confirmed ? confirmed.toISOString() : null,
    estimated,
    businessDays: round4(businessDaysBetween(submittedAt, settledAt)),
    availability: eth.availability,
    payeeOfframpEstimateEur,
    offrampNote: offramp.country_note[country] ?? null,
    travelRuleNote,
    note: estimated
      ? `Pending: inclusion assumed at ${eth.inclusion_seconds} s; fee shown at the 150k gas budget.`
      : `Included ${round4(seconds)} s after submission; testnet fee ~EUR 0, mainnet-equivalent at ${mainnetGwei} gwei.`,
  };
}

// ---------- public API ----------

export function comparePayout(input: ComparePayoutInput): ComparePayoutResult {
  const country = input.country.toUpperCase();
  const submittedAt = toDate(input.submittedAt);
  const sepa = isSepaCountry(country);
  const eea = isEeaCountry(country);
  const localCurrency = input.localCurrency === undefined ? localCurrencyOf(country) : input.localCurrency;
  const used: Assumption[] = [];

  const swift = swiftBaseline(input, submittedAt, country, !eea, used);
  const sepaRail = sepaBaseline(input, submittedAt, country, localCurrency, used);
  const wise = wiseBaseline(input, submittedAt, localCurrency, used);
  const actual = actualRail(input, submittedAt, country, used);

  const reference: 'swift' | 'sepa' = sepa ? 'sepa' : 'swift';
  const ref = reference === 'sepa' ? sepaRail : swift;
  const settledAt = actual.confirmedAt ? toDate(actual.confirmedAt) : new Date(submittedAt.getTime() + rails.eurc.ethereum.inclusion_seconds * 1000);

  const savedEur = round2(ref.feeEur - actual.mainnetEquivalentFeeEur);
  const savedEurNetOfOfframp = round2(savedEur - actual.payeeOfframpEstimateEur);
  const savedBusinessDays = ref.etaAt ? round4(businessDaysBetween(settledAt, toDate(ref.etaAt))) : 0;
  const savedHours = ref.etaAt ? round4((toDate(ref.etaAt).getTime() - settledAt.getTime()) / 3_600_000) : 0;
  const savedEurVsSwift = round2(swift.feeEur - actual.mainnetEquivalentFeeEur);
  const savedBusinessDaysVsSwift = swift.etaAt ? round4(businessDaysBetween(settledAt, toDate(swift.etaAt))) : 0;

  return {
    country,
    sepa,
    eea,
    localCurrency,
    amountEur: input.amountEur,
    submittedAt: submittedAt.toISOString(),
    baselines: { swift, sepa: sepaRail, wise },
    actual,
    reference,
    savedEur,
    savedEurNetOfOfframp,
    savedBusinessDays,
    savedHours,
    savedEurVsSwift,
    savedBusinessDaysVsSwift,
    assumptionsUsed: dedupeAssumptions(used),
  };
}

export interface MonthlySummary {
  count: number;
  totalEur: number;
  /** Fees actually paid on chain (testnet ~0). */
  actualFeeEur: number;
  mainnetEquivalentFeeEur: number;
  /** Sum of per-payout savings vs the realistic reference rail (SEPA or SWIFT). */
  savedEur: number;
  savedEurNetOfOfframp: number;
  savedBusinessDays: number;
  savedHours: number;
  /** Savings if every payout had gone by SWIFT (drawer figure; overstates SEPA corridors). */
  savedEurVsSwift: number;
  savedBusinessDaysVsSwift: number;
  /** Fee savings counted on non-SEPA corridors only, vs SWIFT; the headline number. */
  savedEurSwiftCorridors: number;
  swiftCorridorCount: number;
  sepaCorridorCount: number;
  avgSettlementSeconds: number | null;
  medianSettlementSeconds: number | null;
  byCountry: Record<string, { count: number; totalEur: number; savedEur: number; savedBusinessDays: number; reference: 'swift' | 'sepa' }>;
  assumptions: Assumption[];
  results: ComparePayoutResult[];
}

function isResult(x: ComparePayoutInput | ComparePayoutResult): x is ComparePayoutResult {
  return (x as ComparePayoutResult).baselines !== undefined;
}

/** Roll up per-payout comparisons for a period (callers filter by month). */
export function monthlySummary(payouts: Array<ComparePayoutInput | ComparePayoutResult>): MonthlySummary {
  const results = payouts.map((p) => (isResult(p) ? p : comparePayout(p)));
  const byCountry: MonthlySummary['byCountry'] = {};
  let totalEur = 0;
  let actualFeeEur = 0;
  let mainnetFee = 0;
  let savedEur = 0;
  let savedNet = 0;
  let savedDays = 0;
  let savedHours = 0;
  let savedSwift = 0;
  let savedSwiftDays = 0;
  let savedSwiftCorridors = 0;
  let swiftCount = 0;
  let sepaCount = 0;
  const settle: number[] = [];
  for (const r of results) {
    totalEur += r.amountEur;
    actualFeeEur += r.actual.feeEur ?? 0;
    mainnetFee += r.actual.mainnetEquivalentFeeEur;
    savedEur += r.savedEur;
    savedNet += r.savedEurNetOfOfframp;
    savedDays += r.savedBusinessDays;
    savedHours += r.savedHours;
    savedSwift += r.savedEurVsSwift;
    savedSwiftDays += r.savedBusinessDaysVsSwift;
    if (r.sepa) sepaCount += 1;
    else {
      swiftCount += 1;
      savedSwiftCorridors += r.savedEurVsSwift;
    }
    if (r.actual.seconds !== null) settle.push(r.actual.seconds);
    const bucket = byCountry[r.country] ?? { count: 0, totalEur: 0, savedEur: 0, savedBusinessDays: 0, reference: r.reference };
    bucket.count += 1;
    bucket.totalEur = round2(bucket.totalEur + r.amountEur);
    bucket.savedEur = round2(bucket.savedEur + r.savedEur);
    bucket.savedBusinessDays = round4(bucket.savedBusinessDays + r.savedBusinessDays);
    byCountry[r.country] = bucket;
  }
  const sorted = [...settle].sort((a, b) => a - b);
  const median = sorted.length ? (sorted[(sorted.length - 1) >> 1] as number) : null;
  return {
    count: results.length,
    totalEur: round2(totalEur),
    actualFeeEur: round4(actualFeeEur),
    mainnetEquivalentFeeEur: round4(mainnetFee),
    savedEur: round2(savedEur),
    savedEurNetOfOfframp: round2(savedNet),
    savedBusinessDays: round4(savedDays),
    savedHours: round4(savedHours),
    savedEurVsSwift: round2(savedSwift),
    savedBusinessDaysVsSwift: round4(savedSwiftDays),
    savedEurSwiftCorridors: round2(savedSwiftCorridors),
    swiftCorridorCount: swiftCount,
    sepaCorridorCount: sepaCount,
    avgSettlementSeconds: settle.length ? round4(settle.reduce((a, b) => a + b, 0) / settle.length) : null,
    medianSettlementSeconds: median,
    byCountry,
    assumptions: dedupeAssumptions(results.flatMap((r) => r.assumptionsUsed)),
    results,
  };
}
