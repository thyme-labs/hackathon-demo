// Remittance advice: one print-ready A4 page (light theme, inline CSS) per payout.
// Returns a complete HTML document; the UI can open it in a new tab and use the
// browser's print dialog ("Save as PDF"). No external assets, so it also converts
// with `soffice --headless --convert-to pdf`.

import { createHash } from 'node:crypto';
import { formatPrague } from './calendar';
import type { CnbRate } from './cnb';
import { type CzkLegs, computeCzkLegs, cnbRateFromStored, eurcHumanAmount, formatEurc, formatFixed, payoutAccountingDate, roundHalfUp, toEurcRaw } from './fx';
import { feeEthOf, feeEurOf } from './ledger';
import { type ComparePayoutResult, rails } from './rails';
import { type BeneficiaryRow, type ChecklistItem, EURC_SEPOLIA, type InvoiceRow, type NetworkFee, type PayoutRow, SEPOLIA_CHAIN_ID, SEPOLIA_ETHERSCAN } from './types';

export interface RemittancePayer {
  legalName?: string;
  ico?: string;
  vatId?: string;
  safeAddress?: string;
  contact?: string;
}

export interface RemittanceMandate {
  executor?: 'thyme' | 'direct';
  label?: string;
  rolesModule?: string;
  roleKey?: string;
  allowanceKey?: string;
  capEur?: number | null;
  remainingEur?: number | null;
  mandateTxHash?: string | null;
  agentAddress?: string | null;
  thymeProfileId?: string | null;
  thymeExecutionId?: string | null;
}

export interface RemittanceOptions {
  payer?: RemittancePayer;
  mandate?: RemittanceMandate;
  fee?: NetworkFee | null;
  /** Block timestamp (ISO) from the receipt's block; falls back to payout.confirmed_at. */
  blockTimestamp?: string | null;
  /** ČNB rate override; defaults to the values stored on the payout row. */
  cnb?: CnbRate | null;
  /** Precomputed CZK legs (resolveCzkLegs); built from payout/cnb when absent. */
  czkLegs?: CzkLegs | null;
  /** AI-generated explanation; defaults to invoice.decision_text. */
  aiSummary?: string | null;
  modelId?: string | null;
  promptHash?: string | null;
  auditEventId?: string | null;
  comparison?: ComparePayoutResult | null;
  datasetVersions?: Array<{ name: string; id?: string; version?: string; fetchedOn?: string }>;
  generatedAt?: Date;
  remittanceId?: string;
  appUrl?: string;
  etherscanBase?: string;
  chainId?: number;
  chainName?: string;
  /** Place where the service was performed, for the withholding note (default: payee country). */
  placeOfPerformance?: string;
}

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function shortHash(h: string | null | undefined): string {
  if (!h) return '';
  return h.length > 14 ? `${h.slice(0, 8)}…${h.slice(-6)}` : h;
}

function fmtTs(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return escapeHtml(iso);
  return `${formatPrague(d)} Prague (${d.toISOString().replace(/\.\d+Z$/, 'Z')})`;
}

function money(n: number | null | undefined, ccy: string, dp = 2): string {
  if (n === null || n === undefined) return '';
  return `${ccy} ${roundHalfUp(n, dp).toLocaleString('en-GB', { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;
}

function row(label: string, value: string, opts: { mono?: boolean; raw?: boolean } = {}): string {
  const v = opts.raw ? value : escapeHtml(value);
  return `<tr><th>${escapeHtml(label)}</th><td${opts.mono ? ' class="mono"' : ''}>${v}</td></tr>`;
}

function statusLabel(status: PayoutRow['status']): { text: string; cls: string } {
  switch (status) {
    case 'confirmed':
      return { text: 'Paid', cls: 'ok' };
    case 'submitted':
    case 'pending':
      return { text: 'In progress', cls: 'warn' };
    default:
      return { text: 'Not executed', cls: 'bad' };
  }
}

function checkBadge(status: ChecklistItem['status']): string {
  const map: Record<ChecklistItem['status'], string> = { pass: 'ok', warn: 'warn', fail: 'bad', skip: 'muted' };
  return `<span class="badge ${map[status]}">${escapeHtml(status)}</span>`;
}

const SVG_ATTRS = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
const LOCK = `<span class="enf" title="Enforced on chain"><svg ${SVG_ATTRS}><rect x="6" y="10" width="12" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>chain</span>`;
const SPARK = `<span class="enf" title="Checked by the agent"><svg ${SVG_ATTRS}><path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z"/></svg>agent</span>`;

export function remittanceId(payout: PayoutRow, at: Date): string {
  const ym = at.toISOString().slice(0, 7).replace('-', '');
  const tail = payout.id.replace(/[^a-zA-Z0-9]/g, '').slice(-6).toUpperCase() || '000000';
  return `RA-${ym}-${tail}`;
}

export function buildRemittanceAdvice(
  payout: PayoutRow,
  invoice: InvoiceRow,
  beneficiary: BeneficiaryRow,
  checklist: ChecklistItem[],
  options: RemittanceOptions = {},
): string {
  const generatedAt = options.generatedAt ?? new Date();
  const id = options.remittanceId ?? remittanceId(payout, generatedAt);
  const etherscan = options.etherscanBase ?? SEPOLIA_ETHERSCAN;
  const chainId = options.chainId ?? SEPOLIA_CHAIN_ID;
  const chainName = options.chainName ?? 'Ethereum Sepolia (testnet)';
  const status = statusLabel(payout.status);
  const payer = options.payer ?? {};
  const mandate = options.mandate ?? {};
  const executor = mandate.executor ?? payout.executor;

  // CZK legs: explicit > stored on payout > none.
  const payoutDate = payoutAccountingDate(payout);
  const cnb = options.cnb ?? (payout.cnb_rate && payout.cnb_valid_for ? cnbRateFromStored(payout.cnb_rate, payout.cnb_valid_for, payoutDate) : null);
  const feeEth = feeEthOf(options.fee, payout);
  const feeEur = feeEurOf(options.fee, payout);
  const legs = options.czkLegs ?? (cnb ? computeCzkLegs({ amountEur: payout.amount_eur, eurRate: cnb, feeEur }) : null);

  const amountEurc = eurcHumanAmount(payout);
  const eurcRaw = toEurcRaw(amountEurc).toString();
  const invoiceNo = invoice.number ?? invoice.id;
  const invoiceCurrency = (invoice.currency ?? payout.currency ?? 'EUR').toUpperCase();
  const country = beneficiary.country ?? '';
  const txUrl = payout.tx_hash ? `${etherscan}/tx/${payout.tx_hash}` : null;
  const blockTs = options.blockTimestamp ?? payout.confirmed_at ?? null;
  const inclusionSeconds = payout.submitted_at && payout.confirmed_at ? (new Date(payout.confirmed_at).getTime() - new Date(payout.submitted_at).getTime()) / 1000 : null;

  // Most recent check timestamp; printed once in the heading, per-row only when it differs.
  const checkedAt = checklist.reduce<string | null>((latest, c) => (c.at && (!latest || c.at > latest) ? c.at : latest), null);
  const passed = checklist.filter((c) => c.status === 'pass').length;
  const warned = checklist.filter((c) => c.status === 'warn').length;
  const failed = checklist.filter((c) => c.status === 'fail').length;
  const datasetVersions = options.datasetVersions ?? [];
  const aiSummary = options.aiSummary ?? invoice.decision_text ?? null;
  const travel = rails.eurc.travel_rule;
  const placeOfPerformance = options.placeOfPerformance ?? country;

  const docHash = createHash('sha256')
    .update(JSON.stringify({ id, payout: payout.id, tx: payout.tx_hash, amount: eurcRaw, invoice: invoiceNo, payee: payout.to_wallet ?? beneficiary.wallet, cnb: legs?.payout ?? null }))
    .digest('hex');

  const invoiceFx = invoiceCurrency === 'EUR'
    ? 'EUR invoice, no conversion'
    : `1 ${invoiceCurrency} = ${invoice.fx_rate ?? payout.fx_rate ?? '?'} EUR · ${invoice.fx_source ?? 'mid rate'}${invoice.fx_at ? ` · ${fmtTs(invoice.fx_at)}` : ''}`;

  const checksHtml = checklist.length
    ? checklist
        .map(
          (c) => `<tr>
  <td title="${escapeHtml(c.id)}">${escapeHtml(c.label)}</td>
  <td>${checkBadge(c.status)}</td>
  <td>${c.enforcement === 'chain' ? LOCK : SPARK}</td>
  <td>${escapeHtml(c.evidence)}${c.dataset_version ? ` <span class="sub">(dataset ${escapeHtml(c.dataset_id ?? '')} v${escapeHtml(c.dataset_version)})</span>` : ''}</td>
  <td class="src">${escapeHtml(c.source)}${c.at && c.at !== checkedAt ? `<div class="sub">${escapeHtml(formatPrague(c.at))}</div>` : ''}</td>
</tr>`,
        )
        .join('\n')
    : '<tr><td colspan="5" class="muted">No checklist recorded.</td></tr>';

  const legsHtml = legs
    ? [
        row(
          'ČNB rate (CZK per EUR)',
          `${escapeHtml(String(legs.payout.rate))} · valid for ${escapeHtml(legs.payout.validFor)}${legs.payout.provisional ? ' · <strong>PROVISIONAL</strong> (fixing for the payout day not yet declared)' : ''}<div class="sub">${escapeHtml(cnb ? `${cnb.source}${cnb.fetchedAt ? ` · fetched ${fmtTs(cnb.fetchedAt)}` : ''}` : rails.cnb.source_url)}</div>`,
          { raw: true },
        ),
        row('Amount in CZK', `${escapeHtml(money(legs.payout.amountCzk, 'CZK'))}<div class="sub">${escapeHtml(legs.rule)}</div>`, { raw: true }),
        legs.invoice && legs.invoice.currency !== 'EUR'
          ? row(`Invoice leg (${legs.invoice.currency} at ČNB ${legs.invoice.rate}, valid for ${legs.invoice.validFor})`, money(legs.invoice.amountCzk, 'CZK'))
          : '',
        legs.fxDifferenceCzk !== null ? row('FX difference (invoice − payment)', `${money(legs.fxDifferenceCzk, 'CZK')} ${legs.fxDifferenceCzk >= 0 ? '(gain, 663)' : '(loss, 563)'}`) : '',
      ].join('')
    : row('ČNB rate', 'not resolved (payout has no cnb_rate; run resolveCzkLegs after 14:30 Prague)');

  const feeHtml = [
    row('Gas used', options.fee?.gasUsed !== undefined && options.fee?.gasUsed !== null ? String(options.fee.gasUsed) : payout.gas_used !== null && payout.gas_used !== undefined ? String(payout.gas_used) : ''),
    row('Effective gas price', options.fee?.effectiveGasPriceWei !== undefined && options.fee?.effectiveGasPriceWei !== null ? `${String(options.fee.effectiveGasPriceWei)} wei` : ''),
    row('Network fee', feeEth !== null ? `${feeEth.toFixed(12).replace(/0+$/, '').replace(/\.$/, '')} ETH${feeEur !== null ? ` ≈ ${money(feeEur, 'EUR', 6)}` : ''}${legs?.fee ? ` ≈ ${money(legs.fee.feeCzk, 'CZK')}` : ''}` : 'testnet, ~0'),
    options.comparison
      ? row('Mainnet-equivalent fee', `${money(options.comparison.actual.mainnetEquivalentFeeEur, 'EUR', 4)} at ${options.comparison.actual.mainnetEquivalentGasPriceGwei} gwei · Base ≈ ${money(options.comparison.actual.baseEquivalentFeeEur, 'EUR', 4)}`)
      : '',
    row('Paid by', executor === 'thyme' ? 'Sponsored gas via Thyme Flow (Lift)' : 'Agent key (testnet ETH)'),
  ].join('');

  const mandateHtml = [
    row('Executor', executor === 'thyme' ? `Thyme Flow${mandate.thymeExecutionId || payout.thyme_execution_id ? ` · execution ${escapeHtml(mandate.thymeExecutionId ?? payout.thyme_execution_id ?? '')}` : ''}` : 'Direct (agent EOA through Zodiac Roles)', { raw: true }),
    mandate.label ? row('Mandate', mandate.label) : '',
    mandate.rolesModule ? row('Roles module', mandate.rolesModule, { mono: true }) : '',
    mandate.roleKey ? row('Role key', mandate.roleKey, { mono: true }) : '',
    mandate.allowanceKey ? row('Allowance key', mandate.allowanceKey, { mono: true }) : '',
    mandate.capEur !== undefined && mandate.capEur !== null
      ? row('Monthly cap (agent)', `${money(mandate.capEur, 'EUR')}${mandate.remainingEur !== undefined && mandate.remainingEur !== null ? ` · remaining ${money(mandate.remainingEur, 'EUR')}` : ''}`)
      : beneficiary.monthly_limit_eur
        ? row('Monthly limit', money(beneficiary.monthly_limit_eur, 'EUR'))
        : '',
    mandate.mandateTxHash ? row('Safe enabled in', `<a href="${escapeHtml(`${etherscan}/tx/${mandate.mandateTxHash}`)}">${escapeHtml(shortHash(mandate.mandateTxHash))}</a>`, { raw: true, mono: true }) : '',
    mandate.thymeProfileId ? row('Thyme profile', mandate.thymeProfileId, { mono: true }) : '',
    mandate.agentAddress ? row('Agent address', mandate.agentAddress, { mono: true }) : '',
  ].join('');

  const comparisonHtml = options.comparison
    ? (() => {
        const c = options.comparison;
        const ref = c.reference === 'sepa' ? c.baselines.sepa : c.baselines.swift;
        return `<p class="note"><strong>${escapeHtml(ref.label)}</strong> would have cost ${money(ref.feeEur, 'EUR')}${ref.etaLabel ? ` and landed ${escapeHtml(ref.etaLabel)}` : ''}; EURC ${c.actual.seconds !== null ? `settled in ${c.actual.seconds} s` : 'is pending'} at ${money(c.actual.mainnetEquivalentFeeEur, 'EUR', 4)} (mainnet-equivalent). Saved ${money(c.savedEur, 'EUR')} and ${c.savedBusinessDays.toFixed(1)} business days (assumptions v${escapeHtml(rails.version)}).</p>`;
      })()
    : '';

  const taxNotes = [
    `<li><strong>VAT:</strong> service received from a supplier established outside the Czech Republic — reverse charge, VAT self-assessed by the recipient (Act 235/2004 Sb.); rate of the supply date.</li>`,
    `<li><strong>Withholding:</strong> service performed in ${escapeHtml(placeOfPerformance)} by a non-resident without a Czech permanent establishment — not Czech-source income (Act 586/1992 Sb. s.22); no withholding or tax securement applied. Tax residency: ${escapeHtml(country)}${beneficiary.tax_id ? `, tax id ${escapeHtml(beneficiary.tax_id)}` : ''}.</li>`,
    payout.amount_eur > travel.self_hosted_threshold_eur
      ? `<li><strong>Travel Rule:</strong> amount above EUR ${travel.self_hosted_threshold_eur}; when the payee deposits to a CASP, the CASP verifies ownership of the self-hosted wallet (Reg. (EU) 2023/1113 Art. 14(5), 16(2)). Ownership proof on file: ${beneficiary.ownership_proof_json ? 'EIP-712 signature' : 'none'}.</li>`
      : '',
    `<li><strong>Issuer:</strong> ${escapeHtml(rails.eurc.token.issuer)} (LEI ${escapeHtml(rails.eurc.token.issuer_lei)}), ESMA MiCA EMT register, DTI ${escapeHtml(rails.eurc.token.dti)}; 1 EURC redeemable at par in the EEA, no issuer fee (Circle EEA Terms s.3.4, s.24.12).</li>`,
    `<li><strong>Accounting treatment of the EMT</strong> (inventory "svého druhu" per MF 2018 vs e-money) is unsettled; this document books it on an analytic asset account.</li>`,
  ].join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Remittance advice ${escapeHtml(id)} · ${escapeHtml(invoiceNo)}</title>
<style>
  @page { size: A4; margin: 9mm 12mm; }
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  html, body { margin: 0; background: #fff; color: #111; }
  body { font: 9.5px/1.35 Inter, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; letter-spacing: -0.01em; padding: 16px 20px; max-width: 820px; margin: 0 auto; }
  @media print { body { padding: 0; max-width: none; } a { color: inherit; } .noprint { display: none; } }
  h1 { font-size: 18px; font-weight: 600; margin: 0; letter-spacing: -0.03em; }
  h2 { font-size: 9.5px; font-weight: 600; margin: 8px 0 3px; text-transform: uppercase; letter-spacing: 0.04em; color: #3f7d5f; }
  .head { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 1px solid #e3e3e6; padding-bottom: 6px; }
  .head .meta { text-align: right; color: #666; font-size: 9px; }
  .status { display: inline-block; padding: 2px 7px; border-radius: 4px; font-weight: 600; font-size: 9px; margin-top: 3px; }
  .ok { background: #e4f1ea; color: #22583f; } .warn { background: #f6edd9; color: #7a5a14; } .bad { background: #f8e3e3; color: #8a2a2a; } .muted { color: #777; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  table { width: 100%; border-collapse: collapse; }
  table.kv th { text-align: left; font-weight: 500; color: #666; width: 34%; padding: 1px 6px 1px 0; vertical-align: top; }
  table.kv td { padding: 1px 0; vertical-align: top; word-break: break-all; }
  table.checks { font-size: 8.5px; line-height: 1.25; margin-top: 1px; }
  table.checks th { text-align: left; color: #666; font-weight: 500; border-bottom: 1px solid #e3e3e6; padding: 2px 3px; white-space: nowrap; }
  table.checks td { padding: 1.5px 3px; border-bottom: 1px solid #f0f0f2; vertical-align: top; }
  table.checks td.src { color: #555; max-width: 150px; word-break: break-word; }
  h2 .sub { text-transform: none; letter-spacing: 0; font-weight: 400; }
  .mono { font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 8.5px; }
  .sub { color: #888; font-size: 8px; }
  .badge { display: inline-block; padding: 0 5px; border-radius: 3px; font-size: 8px; font-weight: 600; text-transform: uppercase; }
  .enf { white-space: nowrap; color: #555; font-size: 8.5px; display: inline-flex; align-items: center; gap: 3px; }
  .enf svg { width: 10px; height: 10px; }
  .amount { font-size: 20px; font-weight: 600; letter-spacing: -0.03em; }
  .ai { border: 1px solid #d9e7df; background: #f4f9f6; border-radius: 6px; padding: 5px 9px; margin-top: 3px; }
  .ai .label { font-size: 8px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: #3f7d5f; }
  .note { color: #444; margin: 3px 0 0; }
  ul.tax { margin: 1px 0 0 12px; padding: 0; color: #333; font-size: 8px; line-height: 1.3; columns: 2; column-gap: 16px; }
  ul.tax li { margin: 0 0 2px; break-inside: avoid; }
  .foot { margin-top: 6px; padding-top: 4px; border-top: 1px solid #e3e3e6; color: #777; font-size: 8px; display: flex; justify-content: space-between; gap: 12px; }
  a { color: #22583f; text-decoration: none; }
</style>
</head>
<body>
<header class="head">
  <div>
    <h1>Remittance advice</h1>
    <div class="muted">${escapeHtml(payer.legalName ?? 'Thyme Payroll demo company')}${payer.ico ? ` · IČO ${escapeHtml(payer.ico)}` : ''}${payer.vatId ? ` · DIČ ${escapeHtml(payer.vatId)}` : ''}</div>
    ${payer.safeAddress ? `<div class="mono muted">Safe ${escapeHtml(payer.safeAddress)}</div>` : ''}
    <span class="status ${status.cls}">${escapeHtml(status.text)}</span>
  </div>
  <div class="meta">
    <div class="mono">${escapeHtml(id)}</div>
    <div>Issued ${fmtTs(generatedAt.toISOString())}</div>
    <div class="amount">${money(payout.amount_eur, '€')}</div>
    <div class="mono">${escapeHtml(formatEurc(amountEurc))} EURC</div>
  </div>
</header>

<div class="grid">
  <section>
    <h2>Invoice</h2>
    <table class="kv">
      ${row('Invoice number', invoiceNo)}
      ${row('Issue date', invoice.issue_date ?? '')}
      ${row('Due date', invoice.due_date ?? '')}
      ${row('Invoice amount', money(invoice.amount, invoiceCurrency))}
      ${row('Amount in EUR', money(invoice.amount_eur ?? payout.amount_eur, 'EUR'))}
      ${row('FX to EUR', invoiceFx)}
      ${invoice.score !== null && invoice.score !== undefined ? row('Compliance score', `${invoice.score} / 100`) : ''}
    </table>
  </section>
  <section>
    <h2>Payee</h2>
    <table class="kv">
      ${row('Name', beneficiary.name)}
      ${row('Type · country', `${beneficiary.type} · ${country}`)}
      ${beneficiary.tax_id ? row('Tax id', beneficiary.tax_id) : ''}
      ${beneficiary.lei ? row('LEI', beneficiary.lei, { mono: true }) : ''}
      ${row('Wallet', payout.to_wallet ?? beneficiary.wallet ?? '', { mono: true })}
      ${row('Registry status', `${beneficiary.status}${beneficiary.trust_score !== null && beneficiary.trust_score !== undefined ? ` · trust ${beneficiary.trust_score}/100` : ''}`)}
      ${row('Ownership proof', beneficiary.ownership_proof_json ? 'EIP-712 signature on file' : 'none')}
    </table>
  </section>
</div>

<h2>Payment</h2>
<div class="grid">
  <table class="kv">
    ${row('Asset', `${escapeHtml(`${money(amountEurc, 'EURC', 6)} (raw ${eurcRaw})`)}<div class="sub mono">${escapeHtml(EURC_SEPOLIA)}</div>`, { raw: true })}
    ${row('Network', `${chainName} · chain id ${chainId}`)}
    ${row('Transaction', txUrl ? `<a href="${escapeHtml(txUrl)}">${escapeHtml(payout.tx_hash ?? '')}</a>` : 'not submitted', { raw: true, mono: true })}
    ${row('Block', payout.block_number !== null && payout.block_number !== undefined ? String(payout.block_number) : '')}
    ${row('Block time', fmtTs(blockTs))}
    ${row('Submitted', fmtTs(payout.submitted_at))}
    ${row('Inclusion', inclusionSeconds !== null ? `${roundHalfUp(inclusionSeconds, 1)} s after submission` : '')}
    ${payout.error ? row('Error', payout.error) : ''}
  </table>
  <table class="kv">
    ${mandateHtml}
    ${feeHtml}
  </table>
</div>
${comparisonHtml}

<h2>Accounting (CZK)</h2>
<table class="kv">
  ${legsHtml}
</table>

<h2>Compliance checks · ${passed} passed${warned ? `, ${warned} warning${warned > 1 ? 's' : ''}` : ''}${failed ? `, ${failed} failed` : ''}${checkedAt ? ` <span class="sub">· checked ${escapeHtml(formatPrague(checkedAt))} Prague</span>` : ''}</h2>
<table class="checks">
  <thead><tr><th>Check</th><th>Result</th><th>By</th><th>Evidence</th><th>Source</th></tr></thead>
  <tbody>
${checksHtml}
  </tbody>
</table>
${datasetVersions.length ? `<p class="sub">Datasets: ${datasetVersions.map((d) => escapeHtml(`${d.name}${d.id ? ` ${d.id}` : ''}${d.version ? ` v${d.version}` : ''}${d.fetchedOn ? ` (${d.fetchedOn})` : ''}`)).join(' · ')}</p>` : ''}

<h2>Tax and regulatory notes</h2>
<ul class="tax">
${taxNotes}
</ul>

${aiSummary ? `<div class="ai"><div class="label">AI-generated summary · Regulation (EU) 2024/1689 Art. 50</div><div>${escapeHtml(aiSummary)}</div><div class="sub">${options.modelId ? `model ${escapeHtml(options.modelId)}` : ''}${options.promptHash ? ` · prompt sha256 ${escapeHtml(shortHash(options.promptHash))}` : ''} · reviewed against the deterministic checklist above</div></div>` : ''}

<footer class="foot">
  <div>Generated by Thyme Payroll (hackathon demo) · ${options.auditEventId ? `audit event ${escapeHtml(options.auditEventId)} · ` : ''}document sha256 ${escapeHtml(shortHash(docHash))}</div>
  <div>${options.appUrl ? `<a href="${escapeHtml(options.appUrl)}">${escapeHtml(options.appUrl)}</a> · ` : ''}${escapeHtml(chainName)}</div>
</footer>
</body>
</html>
`;
}

/** Plain-text one-liner for toasts / chat: "Paid INV-0412 · 1,250.00 EURC · 0x8e21…aF31". */
export function remittanceSummaryLine(payout: PayoutRow, invoice: InvoiceRow): string {
  return `${statusLabel(payout.status).text} ${invoice.number ?? invoice.id} · ${formatFixed(eurcHumanAmount(payout), 2)} EURC${payout.tx_hash ? ` · ${shortHash(payout.tx_hash)}` : ''}`;
}
