// Row types mirror src/lib/store/schema.sql (+ migrations) one-to-one. JSON columns stay as strings; parse at the edge.

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
/** Only 'thyme' is written today; 'direct' survives on rows from before the agent key was retired. */
export type PayoutExecutor = 'thyme' | 'direct'
export type AgentKind = 'compliance' | 'payment'
export type AgentStatus = 'running' | 'paused'
export type AuditActor = 'agent' | 'owner' | 'thyme' | 'chain'
/** pending = seen (on an invoice or added by hand) but never paid; approved = may be paid; revoked = never paid again. */
export type BeneficiaryWalletStatus = 'pending' | 'approved' | 'revoked'
/** registration = the wallet the owner registered; invoice = printed on an invoice of a known payee; manual = added on the Beneficiaries page. */
export type BeneficiaryWalletSource = 'registration' | 'invoice' | 'manual'

export interface Beneficiary {
  id: string
  name: string
  type: BeneficiaryType
  country: string | null
  tax_id: string | null
  /** The PRIMARY approved wallet (mirrors the beneficiary_wallets row with is_primary = 1). */
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

/** One wallet of a beneficiary (migration 004). Lower-case address; (beneficiary_id, wallet) is unique. */
export interface BeneficiaryWallet {
  id: string
  beneficiary_id: string
  wallet: string
  label: string | null
  status: BeneficiaryWalletStatus
  /** 1 on the wallet mirrored into beneficiaries.wallet (always an approved one). */
  is_primary: number
  ownership_proof_json: string | null
  source: BeneficiaryWalletSource
  approved_by: string | null
  approved_at: string | null
  created_at: string
}

export interface Invoice {
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
  /** 1 while the owner approved the invoice but has not released the payout ("Approve" without "send"). */
  hold: number
  /** 1 when the owner paid despite failed checks ("Send anyway"); audit event owner.override has the reason. */
  override: number
}

export interface Payout {
  id: string
  invoice_id: string
  beneficiary_id: string | null
  amount_eurc: string
  amount_eur: number
  currency: string
  fx_rate: number | null
  cnb_rate: number | null
  cnb_valid_for: string | null
  amount_czk: number | null
  executor: PayoutExecutor
  thyme_execution_id: string | null
  tx_hash: string | null
  status: PayoutStatus
  submitted_at: string | null
  confirmed_at: string | null
  block_number: number | null
  gas_used: number | null
  error: string | null
  created_at: string
  /** 1 when no chain transaction was sent (mock mode); tx_hash is then a labelled placeholder. */
  simulated: number
  effective_gas_price_wei: string | null
  /** Idempotency-Key suffix at Thyme (payout-<invoiceId>-<attempt>); a retry bumps it. */
  attempt: number
  /** 1 when the owner sent this payout despite failed checks ("Send anyway"). */
  override: number
  /** The approved wallet this payout was handed to the rail for (set when the payment agent picks it up). */
  to_wallet: string | null
}

export interface Agent {
  id: string
  name: string
  kind: AgentKind
  status: AgentStatus
  config_json: string | null
  last_run_at: string | null
}

export interface AuditEntry {
  id: number
  ts: string
  actor: AuditActor
  invoice_id: string | null
  beneficiary_id: string | null
  event: string
  details_json: string | null
}

export interface Setting {
  key: string
  value: string | null
}

/** One line of the compliance checklist stored in invoices.checklist_json. */
export type CheckStatus = 'pass' | 'warn' | 'fail' | 'skip'
export type CheckEnforcement = 'chain' | 'agent'
export interface CheckResult {
  id: string
  label: string
  status: CheckStatus
  enforcement: CheckEnforcement
  weight: number
  evidence: string
  source: string
  at: string
}

export type Insert<T, Optional extends keyof T = never> = Omit<T, Optional> & Partial<Pick<T, Optional>>
