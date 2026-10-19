import { budget } from './budget'
import type { CheckSpec } from './context'
import { countryRisk } from './country_risk'
import { eurcBlacklist } from './eurc_blacklist'
import { firmLicenceWarnings } from './firm_licence_warnings'
import { fxRate } from './fx_rate'
import { invoiceIntegrity } from './invoice_integrity'
import { issuerBacking } from './issuer_backing'
import { knownBeneficiary } from './known_beneficiary'
import { ownershipProof } from './ownership_proof'
import { payeeDetailChange } from './payee_detail_change'
import { paymentPattern } from './payment_pattern'
import { pdfForensics } from './pdf_forensics'
import { pepScreening } from './pep_screening'
import { publicFootprint } from './public_footprint'
import { safeRolesHealth } from './safe_roles_health'
import { sanctionsPersonEntity } from './sanctions_person_entity'
import { sanctionsWallet } from './sanctions_wallet'
import { transferPreflight } from './transfer_preflight'
import { travelRuleReadiness } from './travel_rule_readiness'
import { walletMatchesFile } from './wallet_matches_file'

/** Checks run in this order. fx_rate must precede budget (it sets the EUR amount). */
export const CHECKS: CheckSpec[] = [
  knownBeneficiary,
  walletMatchesFile,
  payeeDetailChange,
  sanctionsPersonEntity,
  pepScreening,
  sanctionsWallet,
  firmLicenceWarnings,
  countryRisk,
  publicFootprint,
  invoiceIntegrity,
  pdfForensics,
  fxRate,
  issuerBacking,
  eurcBlacklist,
  safeRolesHealth,
  budget,
  paymentPattern,
  ownershipProof,
  travelRuleReadiness,
  transferPreflight,
]

export type { CheckContext, CheckSpec, LlmCallRecord, MatchedBy } from './context'
