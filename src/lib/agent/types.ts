// Agent-side view of the domain model and the dependency surface the pipeline needs.
// Column names mirror src/lib/store/schema.sql (snake_case). The store itself is
// injected through AgentStore so this module never imports the SQLite layer.

export type BeneficiaryType = 'person' | 'company'
export type BeneficiaryStatus = 'new' | 'active' | 'paused' | 'blocked'
export type InvoiceStatus =
  | 'queued'
  | 'investigating'
  | 'needs_approval'
  | 'approved'
  | 'rejected'
  | 'paying'
  | 'paid'
  | 'failed'
export type PayoutStatus = 'pending' | 'submitted' | 'confirmed' | 'failed' | 'reverted'
/** Rail recorded on a payout row. Only 'thyme' is written today; 'direct' survives on rows from before the agent key was retired. */
export type PaymentExecutor = 'thyme' | 'direct'
export type AuditActor = 'agent' | 'owner' | 'thyme' | 'chain'

export interface BeneficiaryRow {
  id: string
  name: string
  type: BeneficiaryType
  country: string | null
  tax_id: string | null
  wallet: string | null
  email: string | null
  lei: string | null
  website: string | null
  monthly_limit_eur: number
  status: BeneficiaryStatus
  trust_score: number
  total_paid_eur: number
  last_paid_at: string | null
  ownership_proof_json: string | null
  created_at: string
}

export interface InvoiceRow {
  id: string
  beneficiary_id: string | null
  file_path: string | null
  number: string | null
  issue_date: string | null
  due_date: string | null
  currency: string | null
  amount: number | null
  amount_eur: number | null
  fx_rate: number | null
  fx_source: string | null
  fx_at: string | null
  payee_name: string | null
  payee_wallet: string | null
  extracted_json: string | null
  status: InvoiceStatus
  score: number | null
  checklist_json: string | null
  decision_text: string | null
  created_at: string
  updated_at: string
}

export interface PayoutRow {
  id: string
  invoice_id: string
  beneficiary_id: string | null
  /** EURC base units (6 dp) as a decimal string, e.g. "600000000" for 600 EURC. */
  amount_eurc: string
  amount_eur: number
  currency: string
  fx_rate: number | null
  cnb_rate: number | null
  cnb_valid_for: string | null
  amount_czk: number | null
  executor: PaymentExecutor
  thyme_execution_id: string | null
  tx_hash: string | null
  status: PayoutStatus
  submitted_at: string | null
  confirmed_at: string | null
  block_number: number | null
  gas_used: number | null
  error: string | null
  created_at: string
}

export type InvoicePatch = Partial<Omit<InvoiceRow, 'id' | 'created_at'>>

export type NewPayout = Omit<
  PayoutRow,
  | 'id'
  | 'created_at'
  | 'thyme_execution_id'
  | 'tx_hash'
  | 'submitted_at'
  | 'confirmed_at'
  | 'block_number'
  | 'gas_used'
  | 'error'
>

export interface AuditEvent {
  actor: AuditActor
  invoice_id?: string | null
  beneficiary_id?: string | null
  event: string
  details?: Record<string, unknown>
}

/** Minimal store surface the agent needs. Implemented by src/lib/store/repos.ts. */
export interface AgentStore {
  getInvoice(id: string): InvoiceRow | null
  updateInvoice(id: string, patch: InvoicePatch): void
  /** Oldest invoice with status 'queued', or null. */
  nextQueuedInvoice(): InvoiceRow | null
  listBeneficiaries(): BeneficiaryRow[]
  getBeneficiary(id: string): BeneficiaryRow | null
  /** All invoices for a beneficiary except the one given (history for anomaly and duplicate checks). */
  listInvoicesForBeneficiary(beneficiaryId: string, excludeInvoiceId?: string): InvoiceRow[]
  /** Any invoice with this number (any beneficiary) except the one given. */
  findInvoicesByNumber(number: string, excludeInvoiceId?: string): InvoiceRow[]
  /** Confirmed or in-flight payouts for a beneficiary since the given ISO timestamp. */
  listPayoutsSince(beneficiaryId: string, sinceIso: string): PayoutRow[]
  createPayout(payout: NewPayout): PayoutRow
  appendAudit(event: AuditEvent): void
  getSetting(key: string): string | null
}

/** Live on-chain allowance for a beneficiary, read from the Roles modifier (allowances(key)). */
export interface AllowanceSnapshot {
  /** Remaining balance in EURC base units (6 dp). */
  balance: bigint
  maxRefill: bigint
  refill: bigint
  /** Refill period in seconds (0 = one-off). */
  period: number
  /** Unix seconds of the last accrual. */
  timestamp: number
}

export type AllowanceReader = (beneficiary: BeneficiaryRow) => Promise<AllowanceSnapshot | null>

/** Subset of a viem PublicClient used for EIP-1271 aware signature checks. Optional. */
export interface TypedDataVerifier {
  verifyTypedData(args: {
    address: `0x${string}`
    domain: Record<string, unknown>
    types: Record<string, { name: string; type: string }[]>
    primaryType: string
    message: Record<string, unknown>
    signature: `0x${string}`
  }): Promise<boolean>
}

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'skip'
export type Enforcement = 'chain' | 'agent'

export type CheckId =
  | 'known_beneficiary'
  | 'wallet_matches_file'
  | 'sanctions_person_entity'
  | 'sanctions_wallet'
  | 'firm_licence_warnings'
  | 'country_risk'
  | 'public_footprint'
  | 'invoice_integrity'
  | 'fx_rate'
  | 'issuer_backing'
  | 'budget'
  | 'ownership_proof'

export interface CheckResult {
  id: CheckId
  label: string
  status: CheckStatus
  enforcement: Enforcement
  weight: number
  /** One or two plain sentences with the facts the status rests on. */
  evidence: string
  /** Where the facts came from (list name + date, API + timestamp, registry, chain). */
  source: string
  /** ISO timestamp of the check. */
  at: string
  /** Optional structured facts for the UI (rates, matches, ratios). */
  data?: Record<string, unknown>
}

export type ChecklistEntryStatus = CheckStatus | 'pending' | 'running'

/** What is persisted in invoices.checklist_json while and after the pipeline runs. */
export interface ChecklistEntry extends Omit<CheckResult, 'status' | 'evidence' | 'source' | 'at'> {
  status: ChecklistEntryStatus
  evidence: string
  source: string
  at: string | null
}

/** Proposed registry entry for a new payee (shown on the owner's approval card). */
export interface BeneficiaryProposal {
  name: string
  type: BeneficiaryType
  country: string
  tax_id: string | null
  wallet: string | null
  email: string | null
  website: string | null
  lei: string | null
  suggested_limit_eur: number
}

export interface ChecklistSnapshot {
  entries: ChecklistEntry[]
  proposal?: BeneficiaryProposal
  score: number | null
  started_at: string
  finished_at: string | null
  list_versions: Record<string, string>
  llm: { provider: string; calls: number; cost_usd: number; models: string[] }
}

export type PipelineDecision = 'needs_approval' | 'approved' | 'rejected'

export type ProgressEvent =
  | { type: 'extracting'; invoiceId: string }
  | { type: 'extracted'; invoiceId: string; confidence: number; modelId: string }
  | { type: 'matched'; invoiceId: string; beneficiaryId: string | null }
  | { type: 'check_started'; invoiceId: string; checkId: CheckId }
  | { type: 'check_done'; invoiceId: string; result: CheckResult }
  | { type: 'decided'; invoiceId: string; decision: PipelineDecision; score: number }
  | { type: 'error'; invoiceId: string; message: string }

export interface PipelineDeps {
  store: AgentStore
  readAllowance?: AllowanceReader
  verifier?: TypedDataVerifier
  onProgress?: (event: ProgressEvent) => void
  /** Override the auto-pay threshold (defaults to env AUTO_PAY_THRESHOLD or 100). */
  autoPayThreshold?: number
  /** Override 'now' for deterministic runs. */
  now?: () => Date
}
