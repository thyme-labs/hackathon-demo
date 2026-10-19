// Velocity and sub-threshold splitting to one payee, from the payout ledger and the invoice store. Store only.
// Thresholds calibrated on the ČNB synthetic AML set (2Q2026, /tmp/hackathon-research cnb-calibration): ≥3 payouts
// to one payee in 24 h occurs in 1 of 100,000 payee-pairs, ≥4 in 7 d never; 3+ sub-threshold tickets that together
// pass the threshold inside 7 d in 0.005 % of pairs. Windows are anchored on the payee's billing day (printed issue
// date, else arrival) and confirmed by the ledger (a counted payout in the last 7 days), so a backlog of older
// invoices settled in one sitting is a cadence, not a burst; three same-day invoices paid the same week is.
import rails from '../../../../config/rails.json'
import type { InvoiceRow } from '../types'
import { type CheckContext, type CheckSpec, eur, makeResult } from './context'

const spec = { id: 'payment_pattern', label: 'Payment pattern', enforcement: 'agent', weight: 6 } as const

const DAY_MS = 86_400_000
/** EUR 1,000: the self-hosted wallet threshold of Reg. (EU) 2023/1113 (config/rails.json). */
export const SPLIT_THRESHOLD_EUR: number = rails.eurc.travel_rule.self_hosted_threshold_eur
const COUNTED_INVOICE: ReadonlySet<string> = new Set(['approved', 'paying', 'paid'])
const COUNTED_PAYOUT: ReadonlySet<string> = new Set(['pending', 'submitted', 'confirmed'])

const SOURCE = 'payout ledger + invoice store, 7-day window anchored on the billing day; thresholds from the ČNB synthetic AML dataset 2Q2026 (s3 CNB/transactions.csv)'

/** Day the payee billed: the printed issue date, else the day the file arrived. */
const billedAt = (inv: Pick<InvoiceRow, 'issue_date' | 'created_at'>): number => {
  const printed = inv.issue_date ? Date.parse(inv.issue_date) : Number.NaN
  return Number.isFinite(printed) ? printed : Date.parse(inv.created_at)
}

const amountOf = (inv: InvoiceRow): number | null => inv.amount_eur ?? (inv.currency === 'EUR' ? inv.amount : null)

const sum = (xs: InvoiceRow[]): number => xs.reduce((s, i) => s + (amountOf(i) ?? 0), 0)

export const run = async (ctx: CheckContext) => {
  const b = ctx.beneficiary
  if (!b) {
    return makeResult(spec, ctx, { status: 'skip', evidence: 'No payout history for a new payee.', source: SOURCE })
  }
  const amountEur = ctx.out.amountEur ?? (ctx.extracted.invoice.currency === 'EUR' ? ctx.extracted.invoice.gross : null)
  if (amountEur === null) {
    return makeResult(spec, ctx, { status: 'skip', evidence: 'No EUR amount (FX failed); nothing to compare with the ledger.', source: SOURCE })
  }
  const nowMs = ctx.now.getTime()
  const since7 = new Date(nowMs - 7 * DAY_MS).toISOString()
  const thisBilled = billedAt({ issue_date: ctx.extracted.invoice.issue_date, created_at: ctx.invoice.created_at })

  // Earlier invoices of the payee that were paid, or are being paid, in the last 7 days by the ledger.
  const history = ctx.store.listInvoicesForBeneficiary(b.id, ctx.invoice.id)
  const paidRecently = new Set(
    ctx.store
      .listPayoutsSince(b.id, since7)
      .filter((p) => COUNTED_PAYOUT.has(p.status))
      .map((p) => p.invoice_id),
  )
  const recent = history.filter((i) => paidRecently.has(i.id) || (COUNTED_INVOICE.has(i.status) && i.created_at >= since7))
  const within = (days: number) => recent.filter((i) => Math.abs(billedAt(i) - thisBilled) <= days * DAY_MS)
  const day = within(1)
  const week = within(7)
  const n24 = day.length + 1
  const n7 = week.length + 1
  const sum24 = sum(day) + amountEur
  const sum7 = sum(week) + amountEur

  const thisSub = amountEur < SPLIT_THRESHOLD_EUR
  const subThreshold = week.filter((i) => {
    const a = amountOf(i)
    return a !== null && a < SPLIT_THRESHOLD_EUR
  })
  const k = subThreshold.length + (thisSub ? 1 : 0)
  const splitSum = sum(subThreshold) + (thisSub ? amountEur : 0)

  const velocity = n24 >= 3 || n7 >= 4
  const splitting = k >= 3 && splitSum >= SPLIT_THRESHOLD_EUR
  const roundAmount = amountEur >= SPLIT_THRESHOLD_EUR && amountEur % 500 === 0

  const data = {
    amount_eur: amountEur,
    threshold_eur: SPLIT_THRESHOLD_EUR,
    billed_on: new Date(thisBilled).toISOString().slice(0, 10),
    n24,
    sum24: Math.round(sum24 * 100) / 100,
    n7,
    sum7: Math.round(sum7 * 100) / 100,
    k,
    split_sum: Math.round(splitSum * 100) / 100,
    velocity,
    splitting,
    round_amount: roundAmount,
    counted: week.map((i) => ({ id: i.id, number: i.number, billed: new Date(billedAt(i)).toISOString().slice(0, 10), amount_eur: amountOf(i), status: i.status })),
  }

  const findings: string[] = []
  if (velocity) {
    findings.push(
      `${n24} payouts to ${b.name} in the 24 h billing window (${eur(sum24)}) / ${n7} in 7 d; above the calibrated velocity envelope (≥3/24 h occurs in 1 of 100,000 payee-pairs in the ČNB set). Owner review.`,
    )
  }
  if (splitting) {
    findings.push(
      `${k} invoices in 7 days, each under ${eur(SPLIT_THRESHOLD_EUR)}, together ${eur(splitSum)}: splitting below the EUR ${SPLIT_THRESHOLD_EUR.toLocaleString('en-GB')} self-hosted threshold (structuring pattern). Owner review.`,
    )
  }
  if (findings.length > 0) {
    return makeResult(spec, ctx, { status: 'warn', evidence: findings.join(' '), source: SOURCE, data })
  }
  const roundNote = roundAmount ? `; round amount (${eur(amountEur)}), noted only` : ''
  return makeResult(spec, ctx, {
    status: 'pass',
    evidence: `${n24} payout(s) in the 24 h billing window (${eur(sum24)}), ${n7} in 7 d (${eur(sum7)}); ${k} invoice(s) under ${eur(SPLIT_THRESHOLD_EUR)} totalling ${eur(splitSum)}${roundNote}; no velocity or splitting pattern.`,
    source: SOURCE,
    data,
  })
}

export const paymentPattern: CheckSpec = { ...spec, run }
