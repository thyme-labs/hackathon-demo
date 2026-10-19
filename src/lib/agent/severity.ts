// Severity tiers and penalty multipliers for the scoring model (score.ts).
// A check's weight says how much evidence it carries; its tier says how bad a
// finding on it is. A penalty is weight x multiplier, so one failed critical check
// costs several times its weight, and the caps make sure a forged wallet or a
// sanctions hit can never hide behind eleven clean checks.
import type { CheckId, CheckResult, CheckStatus, CheckTier } from './types'

export const CHECK_TIERS: Record<CheckId, CheckTier> = {
  sanctions_person_entity: 'critical',
  sanctions_wallet: 'critical',
  wallet_matches_file: 'critical',
  budget: 'high',
  invoice_integrity: 'high',
  country_risk: 'high',
  known_beneficiary: 'high',
  fx_rate: 'medium',
  issuer_backing: 'medium',
  firm_licence_warnings: 'medium',
  ownership_proof: 'medium',
  // Store-only, deterministic: a finding is a finding; their skips never say "not configured".
  payment_pattern: 'high',
  payee_detail_change: 'high',
  pdf_forensics: 'high',
  // Wikidata lookup and static Travel Rule readiness: medium so a timeout stays a neutral skip.
  pep_screening: 'medium',
  travel_rule_readiness: 'medium',
  // Chain reads: medium so an RPC outage (neutral skip) never holds an invoice; a real finding still fails or warns.
  eurc_blacklist: 'medium',
  safe_roles_health: 'medium',
  transfer_preflight: 'medium',
  public_footprint: 'low',
}

/** Penalty = weight x multiplier for a failed check. */
export const FAIL_MULTIPLIER: Record<CheckTier, number> = { critical: 4, high: 2.5, medium: 1.5, low: 1 }
/** Penalty = weight x multiplier for a warning. */
export const WARN_MULTIPLIER: Record<CheckTier, number> = { critical: 1.5, high: 1, medium: 0.6, low: 0.4 }

/** Hard ceilings applied after the penalty formula, whatever the other checks say. */
export const SCORE_CAPS = { critical_fail: 10, high_fail: 40, critical_warns: 70 } as const
/** Number of warnings on critical checks that triggers the critical_warns cap. */
export const CRITICAL_WARNS_FOR_CAP = 2

/** Unknown ids (a check added later without a tier) score as medium. */
export const tierOf = (id: CheckId): CheckTier => CHECK_TIERS[id] ?? 'medium'

/** Skips that mean "could not look" rather than "nothing to look at" (no key, offline, source down). */
const UNAVAILABLE_RE = /not configured|not set|offline|unavailable|unreachable|timed out/i

/**
 * True when a check was skipped because its data source was unavailable. Checks that
 * know it say so in data (configured: false / offline: true); otherwise it is inferred
 * from the evidence text, which the checks phrase as "not configured" or "offline".
 */
export const isUnavailableSkip = (r: CheckResult): boolean =>
  r.status === 'skip' && (r.data?.configured === false || r.data?.offline === true || UNAVAILABLE_RE.test(r.evidence))

/**
 * Status the scorer uses. A skip stays neutral (no penalty, leaves the denominator),
 * except that a critical or high check skipped for missing data is scored as a warning:
 * not knowing whether a payee is sanctioned is a finding, not a free pass.
 */
export const effectiveStatus = (r: CheckResult): CheckStatus => {
  if (r.status !== 'skip' || !isUnavailableSkip(r)) return r.status
  const tier = tierOf(r.id)
  return tier === 'critical' || tier === 'high' ? 'warn' : 'skip'
}
