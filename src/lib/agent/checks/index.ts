import { budget } from './budget'
import type { CheckSpec } from './context'
import { countryRisk } from './country_risk'
import { firmLicenceWarnings } from './firm_licence_warnings'
import { fxRate } from './fx_rate'
import { invoiceIntegrity } from './invoice_integrity'
import { issuerBacking } from './issuer_backing'
import { knownBeneficiary } from './known_beneficiary'
import { ownershipProof } from './ownership_proof'
import { publicFootprint } from './public_footprint'
import { sanctionsPersonEntity } from './sanctions_person_entity'
import { sanctionsWallet } from './sanctions_wallet'
import { walletMatchesFile } from './wallet_matches_file'

/** Checks run in this order. fx_rate must precede budget (it sets the EUR amount). */
export const CHECKS: CheckSpec[] = [
  knownBeneficiary,
  walletMatchesFile,
  sanctionsPersonEntity,
  sanctionsWallet,
  firmLicenceWarnings,
  countryRisk,
  publicFootprint,
  invoiceIntegrity,
  fxRate,
  issuerBacking,
  budget,
  ownershipProof,
]

export type { CheckContext, CheckSpec, LlmCallRecord, MatchedBy } from './context'
