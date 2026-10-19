import type { ExtractedInvoice } from '../extract'
import type { CnbRate, FxResolution } from '../fx'
import type { LlmProvider } from '../providers/types'
import type {
  AgentStore,
  BeneficiaryRow,
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
