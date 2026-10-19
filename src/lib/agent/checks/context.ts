import type { ExtractedInvoice } from '../extract'
import type { CnbRate, FxResolution } from '../fx'
import type { PayeeTypeResolution } from '../payee-type'
import type { LlmProvider } from '../providers/types'
import type {
  AgentStore,
  BeneficiaryRow,
  BeneficiaryWalletRow,
  CheckId,
  CheckResult,
  CheckStatus,
  Enforcement,
  InvoiceRow,
  PipelineDeps,
} from '../types'

export type MatchedBy = 'tax_id' | 'wallet' | 'name' | null

export interface LlmCallRecord {
  purpose: string
  modelId: string
  costUsd: number
  latencyMs: number
}

export interface CheckContext {
  invoice: InvoiceRow
  extracted: ExtractedInvoice
  beneficiary: BeneficiaryRow | null
  matchedBy: MatchedBy
  /** Every wallet row of the matched beneficiary (approved, pending and revoked); empty without a beneficiary. */
  wallets: BeneficiaryWalletRow[]
  /** person | company: registry for known beneficiaries, else extractor + printed legal form (payee-type.ts). */
  payeeType: PayeeTypeResolution
  store: AgentStore
  deps: PipelineDeps
  provider: LlmProvider
  now: Date
  /** Shared outputs written by earlier checks (fx_rate) and read by later ones (budget). */
  out: {
    amountEur?: number
    fx?: FxResolution
    cnb?: CnbRate | null
  }
  llmCalls: LlmCallRecord[]
}

export interface CheckSpec {
  id: CheckId
  label: string
  enforcement: Enforcement
  weight: number
  run: (ctx: CheckContext) => Promise<CheckResult>
}

export interface ResultInput {
  status: CheckStatus
  evidence: string
  source: string
  data?: Record<string, unknown>
}

/** Builds a CheckResult for a spec; keeps id/label/weight/enforcement consistent. */
export const makeResult = (spec: Omit<CheckSpec, 'run'>, ctx: CheckContext, input: ResultInput): CheckResult => ({
  id: spec.id,
  label: spec.label,
  enforcement: spec.enforcement,
  weight: spec.weight,
  status: input.status,
  evidence: input.evidence,
  source: input.source,
  at: ctx.now.toISOString(),
  ...(input.data ? { data: input.data } : {}),
})

export const shortAddr = (addr: string | null | undefined): string =>
  addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : 'none'

export const eur = (n: number): string =>
  `€${n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/**
 * Wallets of the matched beneficiary the rail may pay: approved rows of beneficiary_wallets, or the legacy
 * beneficiaries.wallet when the store has no wallet rows yet (rows written before migration 004).
 */
export const approvedWallets = (ctx: CheckContext): { wallet: string; label: string | null; isPrimary: boolean; approvedAt: string | null; hasProof: boolean }[] => {
  const rows = ctx.wallets.filter((w) => w.status === 'approved')
  if (rows.length > 0) {
    return rows.map((w) => ({ wallet: w.wallet.toLowerCase(), label: w.label, isPrimary: w.is_primary === 1, approvedAt: w.approved_at, hasProof: Boolean(w.ownership_proof_json) }))
  }
  const legacy = ctx.beneficiary?.wallet?.toLowerCase() ?? null
  return legacy ? [{ wallet: legacy, label: 'primary', isPrimary: true, approvedAt: null, hasProof: Boolean(ctx.beneficiary?.ownership_proof_json) }] : []
}
