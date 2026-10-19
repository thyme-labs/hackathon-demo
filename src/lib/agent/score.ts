// Scoring: weighted penalties with severity tiers and hard caps (tiers and multipliers
// live in severity.ts so the table can be read on its own).
//
//   penalty(check) = weight x FAIL_MULTIPLIER[tier]   for a fail
//                  = weight x WARN_MULTIPLIER[tier]   for a warn
//                  = 0                                for a pass
//   skip is neutral: no penalty and its weight leaves the denominator, except that a
//   critical/high check skipped for missing data is scored as a warn (severity.ts).
//   raw   = max(0, 100 - sum(penalty) / sum(weight of counted checks) x 100)
//   score = min(raw, cap), cap = 10 on any critical fail, 40 on any high fail,
//           70 on two or more critical warns. One decimal.
//
// The status decision stays separate from the score: any fail rejects; an unknown,
// inactive or low-trust beneficiary needs the owner; otherwise score >= threshold pays.
import { CRITICAL_WARNS_FOR_CAP, effectiveStatus, FAIL_MULTIPLIER, SCORE_CAPS, tierOf, WARN_MULTIPLIER } from './severity'
import type {
  BeneficiaryRow,
  CheckResult,
  PipelineDecision,
  ScoreBreakdownEntry,
  ScoreCapApplied,
  ScoringSnapshot,
} from './types'

export const SCORING_MODEL = 'tiered-v1' as const
/** Beneficiaries below this trust score are never paid without the owner, whatever the invoice scores. */
export const MIN_TRUST_FOR_AUTOPAY = 60

export interface ScoreSummary {
  /** Final score 0..100 (one decimal) after caps. */
  score: number
  /** Denominator: summed weight of the counted (non-skipped) checks. */
  total: number
  /** Summed penalty points before scaling to 100. */
  penalty: number
  fails: CheckResult[]
  /** Results scored as warnings: status warn, or a critical/high check skipped for missing data. */
  warns: CheckResult[]
  /** Persisted as ChecklistSnapshot.scoring so the UI can show why the score is what it is. */
  scoring: ScoringSnapshot
}

const round1 = (n: number): number => Math.round(n * 10) / 10

const labels = (entries: ScoreBreakdownEntry[]): string => entries.map((e) => e.label).join(', ')

const breakdownEntry = (r: CheckResult): ScoreBreakdownEntry => {
  const tier = tierOf(r.id)
  const status = effectiveStatus(r)
  const base = { id: r.id, label: r.label, tier, weight: r.weight, status }
  if (status === 'fail') {
    const penalty = round1(r.weight * FAIL_MULTIPLIER[tier])
    return { ...base, penalty, note: `fail: ${r.weight} x ${FAIL_MULTIPLIER[tier]} = ${penalty} points` }
  }
  if (status === 'warn') {
    const penalty = round1(r.weight * WARN_MULTIPLIER[tier])
    const why = r.status === 'skip' ? `skipped for missing data on a ${tier} check, scored as a warning` : 'warn'
    return { ...base, penalty, note: `${why}: ${r.weight} x ${WARN_MULTIPLIER[tier]} = ${penalty} points` }
  }
  if (status === 'skip') return { ...base, penalty: 0, note: 'skipped: not counted (no penalty, no credit)' }
  return { ...base, penalty: 0, note: 'pass: no penalty' }
}

/** Caps in ascending order, so caps[0] is the one that binds. */
const capsFor = (entries: ScoreBreakdownEntry[]): ScoreCapApplied[] => {
  const caps: ScoreCapApplied[] = []
  const criticalFails = entries.filter((e) => e.tier === 'critical' && e.status === 'fail')
  if (criticalFails.length > 0) {
    caps.push({ rule: 'critical_fail', cap: SCORE_CAPS.critical_fail, checks: criticalFails.map((e) => e.id), reason: `${labels(criticalFails)} failed (critical)` })
  }
  const highFails = entries.filter((e) => e.tier === 'high' && e.status === 'fail')
  if (highFails.length > 0) {
    caps.push({ rule: 'high_fail', cap: SCORE_CAPS.high_fail, checks: highFails.map((e) => e.id), reason: `${labels(highFails)} failed (high)` })
  }
  const criticalWarns = entries.filter((e) => e.tier === 'critical' && e.status === 'warn')
  if (criticalWarns.length >= CRITICAL_WARNS_FOR_CAP) {
    caps.push({
      rule: 'critical_warns',
      cap: SCORE_CAPS.critical_warns,
      checks: criticalWarns.map((e) => e.id),
      reason: `${criticalWarns.length} warnings on critical checks (${labels(criticalWarns)})`,
    })
  }
  return caps.sort((a, b) => a.cap - b.cap)
}

const explanationFor = (score: number, penalty: number, total: number, entries: ScoreBreakdownEntry[], caps: ScoreCapApplied[]): string => {
  if (caps.length > 0) return `Capped at ${caps[0].cap}: ${caps[0].reason}.`
  const counted = entries.filter((e) => e.status !== 'skip')
  const skipped = entries.length - counted.length
  const skippedNote = skipped > 0 ? `; ${skipped} check${skipped === 1 ? '' : 's'} skipped` : ''
  if (total === 0) return 'No check produced evidence; nothing to score.'
  if (penalty === 0) return `All ${counted.length} counted checks passed${skippedNote}.`
  const findings = counted.filter((e) => e.penalty > 0).map((e) => `${e.label} ${e.status === 'fail' ? 'failed' : 'warned'} (-${e.penalty})`)
  return `Score ${score}: ${findings.join(', ')}; ${penalty} of ${total} counted points lost${skippedNote}.`
}

export const computeScore = (results: CheckResult[]): ScoreSummary => {
  const breakdown = results.map(breakdownEntry)
  const counted = breakdown.filter((e) => e.status !== 'skip')
  const total = counted.reduce((sum, e) => sum + e.weight, 0)
  const penalty = round1(counted.reduce((sum, e) => sum + e.penalty, 0))
  const raw = total === 0 ? 0 : round1(Math.max(0, 100 - (penalty / total) * 100))
  const caps = capsFor(breakdown)
  const cap = caps.length > 0 ? caps[0].cap : null
  const score = cap === null ? raw : Math.min(raw, cap)
  const scoring: ScoringSnapshot = {
    model: SCORING_MODEL,
    score,
    raw_score: raw,
    penalty,
    total,
    cap,
    caps,
    breakdown,
    explanation: explanationFor(score, penalty, total, breakdown, caps),
  }
  return {
    score,
    total,
    penalty,
    fails: results.filter((_, i) => breakdown[i].status === 'fail'),
    warns: results.filter((_, i) => breakdown[i].status === 'warn'),
    scoring,
  }
}

/**
 * Short plain lines for a "why this score" panel: the one-line explanation, one line
 * per check that cost points or was skipped, then any further caps. Accepts the live
 * summary or the persisted ChecklistSnapshot.scoring. Never quotes check evidence
 * (which may carry text lifted from the invoice); the checklist shows that next to each check.
 */
export const describeScore = (input: ScoreSummary | ScoringSnapshot): string[] => {
  const s = 'scoring' in input ? input.scoring : input
  const lines = [s.explanation]
  for (const e of s.breakdown) {
    if (e.status === 'pass') continue
    lines.push(e.status === 'skip' ? `${e.label}: skipped, not counted` : `${e.label}: ${e.status} (${e.tier}, -${e.penalty} points)`)
  }
  for (const c of s.caps.slice(1)) lines.push(`Also capped at ${c.cap}: ${c.reason}`)
  if (s.cap !== null && s.raw_score !== s.score) lines.push(`Before caps: ${s.raw_score}`)
  return lines
}

/** Auto-pay settings the owner edits on /settings (settings table; env AUTO_PAY_THRESHOLD is the fallback). */
export interface AutoPayOptions {
  /** False: nothing is approved without the owner, whatever the score (default true). */
  autoPayEnabled?: boolean
}

/** Minimal view of the decision inputs, so the same sentence can be rebuilt from the persisted snapshot. */
export type DecisionSummary = Pick<ScoreSummary, 'score'> & { fails: Pick<CheckResult, 'label'>[] }

/**
 * Any fail rejects. The owner must approve when the payee is unknown, not active, or
 * has a trust score under MIN_TRUST_FOR_AUTOPAY (the score rates this invoice, trust
 * rates the relationship; a low-trust payee is not auto-paid on one clean invoice),
 * and always when auto-pay is switched off. Otherwise score >= threshold pays.
 */
export const decideStatus = (
  summary: DecisionSummary,
  beneficiary: BeneficiaryRow | null,
  threshold: number,
  options: AutoPayOptions = {},
): PipelineDecision => {
  if (summary.fails.length > 0) return 'rejected'
  if (!beneficiary || beneficiary.status !== 'active') return 'needs_approval'
  if (beneficiary.trust_score < MIN_TRUST_FOR_AUTOPAY) return 'needs_approval'
  if (options.autoPayEnabled === false) return 'needs_approval'
  return summary.score >= threshold ? 'approved' : 'needs_approval'
}

/** One sentence on why decideStatus decided as it did (same branch order). */
export const decisionReason = (
  summary: DecisionSummary,
  beneficiary: BeneficiaryRow | null,
  threshold: number,
  options: AutoPayOptions = {},
): string => {
  if (summary.fails.length > 0) return `${summary.fails.map((f) => f.label).join(', ')} failed; no money moves on a failed check.`
  if (!beneficiary) return 'New payee: the owner registers the wallet and monthly limit on approval.'
  if (beneficiary.status !== 'active') return `${beneficiary.name} is ${beneficiary.status}; the owner must activate it first.`
  if (beneficiary.trust_score < MIN_TRUST_FOR_AUTOPAY) {
    return `Trust ${beneficiary.trust_score}/100 is below ${MIN_TRUST_FOR_AUTOPAY}; owner approval required regardless of score.`
  }
  if (options.autoPayEnabled === false) return `Auto-pay is off: score ${summary.score}, the owner releases every payout.`
  return summary.score >= threshold
    ? `Score ${summary.score} meets the auto-pay threshold ${threshold}.`
    : `Score ${summary.score} is below the auto-pay threshold ${threshold}.`
}

/** Suggested monthly limit for a new payee: 2.5x the first invoice, rounded up to €100. */
export const suggestMonthlyLimit = (amountEur: number): number => Math.max(100, Math.ceil((amountEur * 2.5) / 100) * 100)
