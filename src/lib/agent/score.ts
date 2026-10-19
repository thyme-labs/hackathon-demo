import type { BeneficiaryRow, CheckResult, PipelineDecision } from './types'

export interface ScoreSummary {
  score: number
  earned: number
  total: number
  fails: CheckResult[]
  warns: CheckResult[]
}

/** pass/skip earn the full weight, warn half, fail nothing. Score is 0..100. */
export const computeScore = (results: CheckResult[]): ScoreSummary => {
  let earned = 0
  let total = 0
  for (const r of results) {
    total += r.weight
    if (r.status === 'pass' || r.status === 'skip') earned += r.weight
    else if (r.status === 'warn') earned += r.weight / 2
  }
  const score = total === 0 ? 0 : Math.round((earned / total) * 1000) / 10
  return { score, earned, total, fails: results.filter((r) => r.status === 'fail'), warns: results.filter((r) => r.status === 'warn') }
}

export const decideStatus = (
  summary: ScoreSummary,
  beneficiary: BeneficiaryRow | null,
  threshold: number,
): PipelineDecision => {
  if (summary.fails.length > 0) return 'rejected'
  if (!beneficiary || beneficiary.status !== 'active') return 'needs_approval'
  return summary.score >= threshold ? 'approved' : 'needs_approval'
}

/** Suggested monthly limit for a new payee: 2.5x the first invoice, rounded up to €100. */
export const suggestMonthlyLimit = (amountEur: number): number => Math.max(100, Math.ceil((amountEur * 2.5) / 100) * 100)
