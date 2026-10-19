// Shapes returned by the server functions to the UI. Types only: safe to import anywhere.
import type { ChecklistSnapshot } from '../agent/types'
import type { Agent, AuditEntry, Beneficiary, Invoice, Payout } from '../store/types'

export type { ChecklistSnapshot }

/** PAYMENT_EXECUTOR: Thyme Flow is the only rail; 'simulated' records labelled fake payouts. */
export type PaymentExecutorName = 'thyme' | 'simulated'

export interface InvoiceListItem {
  id: string
  number: string | null
  payee_name: string | null
  beneficiary_name: string | null
  currency: string | null
  amount: number | null
  amount_eur: number | null
  status: Invoice['status']
  score: number | null
  created_at: string
  updated_at: string
}

export interface ExtractedView {
  payee: { name: string; address: string; country: string; tax_id: string | null; lei: string | null; email: string | null; website: string | null }
  invoice: { number: string; issue_date: string | null; due_date: string | null; currency: string; net: number; vat: number; gross: number; line_items: { description: string; quantity: number; unit_price: number; total: number }[] }
  payment: { wallet: string | null; chain: string | null; iban: string | null; bic: string | null; token: string | null }
  notes: string | null
  suspicious_text: string[]
  confidence: number
}

export interface ExecutionModeInfo {
  mode: 'thyme' | 'simulated'
  reason: string
}

/** Where the Safe stands with Thyme, as the invoice view needs it. */
export interface SafeRailInfo {
  safeAddress: string | null
  profileId: string | null
  onboarded: boolean
  simulated: boolean
}

export interface InvoiceDetail {
  invoice: Invoice
  checklist: ChecklistSnapshot
  extracted: ExtractedView | null
  beneficiary: Beneficiary | null
  payouts: Payout[]
  audit: AuditEntry[]
  provider: { name: string; label: string }
  executionMode: ExecutionModeInfo
  rail: SafeRailInfo
}

export interface DemoInvoiceItem {
  file: string
  number: string
  hint: string
  size: number
  alreadyQueued: boolean
}

export interface BeneficiaryListItem extends Beneficiary {
  paid_this_month_eur: number
  invoice_count: number
}

export interface BeneficiaryDetail {
  beneficiary: Beneficiary
  invoices: InvoiceListItem[]
  payouts: Payout[]
  lastChecklist: ChecklistSnapshot | null
  paid_this_month_eur: number
}

// ── Thyme onboarding ──────────────────────────────────────────────────────

export type ThymeProfileState = 'pending' | 'active' | 'failed'
export type ThymeExecutableState = 'provisioning' | 'active' | 'paused' | 'error' | 'deleted'
export type ThymeTriggerModeName = 'webhook' | 'management-run' | 'none'
export type OnboardingStep = 'connect' | 'safe' | 'enable' | 'setup' | 'executable' | 'done'

export interface ScopeSummary {
  /** What Thyme can do on the Safe (chain). */
  can: string[]
  /** What the Roles scope forbids (chain). */
  cant: string[]
}

export interface AllowlistRuleView {
  target: string
  selector: string
  functionSignature?: string
}

/** Everything the onboarding page, settings and agents page show about the Safe + Thyme. No credentials. */
export interface ThymeOnboardingView {
  /** THYME_API_KEY + THYME_PROJECT_ID + THYME_FUNCTION_ID are set: the server can drive the onboarding. */
  configured: boolean
  missingEnv: string[]
  apiHost: string | null
  executor: PaymentExecutorName
  appUrl: string
  pullTokenSet: boolean
  triggerMode: ThymeTriggerModeName
  safeAddress: string | null
  ownerAddress: string | null
  profileId: string | null
  profileAlias: string | null
  profileStatus: ThymeProfileState | null
  profileError: string | null
  rolesProxy: string | null
  executorSafe: string | null
  setupTxHash: string | null
  executableId: string | null
  executableStatus: ThymeExecutableState | null
  executablePausedReason: string | null
  hasWebhook: boolean
  lastExecutionId: string | null
  simulatedAt: string | null
  /** Real onboarding complete: active profile + executable + webhook. */
  onboarded: boolean
  /** The owner chose the labelled simulation instead. */
  simulated: boolean
  /** onboarded || simulated: beneficiaries can be registered and payouts flow (real or labelled). */
  ready: boolean
  step: OnboardingStep
  scope: ScopeSummary
  allowlist: AllowlistRuleView[]
}

export interface OwnerTransactionDto {
  to: string
  /** Hex wei, '0x0'. */
  value: string
  data: string
}

export interface PrepareProfileResult {
  profileId: string
  alias: string
  chainId: number
  safeAddress: string
  ownerAddress: string
  /** The owner sends this from MetaMask as-is (plain EOA transaction to the Safe). */
  transaction: OwnerTransactionDto
  predicted: { rolesProxy: string; executorSafe: string }
  scopeRules: AllowlistRuleView[]
  setupDataHash: string
  scope: ScopeSummary
}

export interface ConfirmSetupResult {
  /** 'pending' = Thyme has no receipt yet (409 setup_not_mined): call again. */
  status: 'active' | 'pending'
  message: string
  rolesProxy: string | null
  executorSafe: string | null
  txHash: string
}

export interface ProfileStatusResult {
  status: ThymeProfileState
  profileStatus: string
  lastError: string | null
  rolesProxy: string | null
  executorSafe: string | null
  setupTxHash: string | null
  liftPolicyId: string | null
}

export interface ExecutableResult {
  executableId: string
  status: ThymeExecutableState
  pausedReason: string | null
  hasWebhook: boolean
  /** Active and reachable through the webhook. */
  ready: boolean
  message: string
}

/** What registering a beneficiary means now: no Safe transaction, the rail is already scoped. */
export interface RegistrationPlan {
  /** Thyme onboarded (real) or simulated: the registration can go ahead. */
  ready: boolean
  onboarded: boolean
  simulated: boolean
  executor: PaymentExecutorName
  reason: string
  safeAddress: string | null
  profileId: string | null
  payees: number
  limitEur: number
  /** Enforced on chain by Thyme's Roles scope. */
  chain: string[]
  /** Enforced by the payroll agent before a payout is handed to Thyme. */
  agent: string[]
}

export interface ThymeAgentInfo {
  triggerMode: ThymeTriggerModeName
  onboarded: boolean
  simulated: boolean
  safeAddress: string | null
  profileId: string | null
  profileStatus: ThymeProfileState | null
  executableId: string | null
  executableStatus: ThymeExecutableState | null
  executablePausedReason: string | null
  hasWebhook: boolean
  lastExecutionId: string | null
  rolesProxy: string | null
  executorSafe: string | null
}

export interface AgentView extends Agent {
  config: Record<string, unknown>
  cost_usd: number
  llm_calls: number
  runs: AuditEntry[]
  executor: PaymentExecutorName
  execution: ExecutionModeInfo
  thyme: ThymeAgentInfo
  payees: number
  limit_eur: number
  used_eur: number
}

export interface PayoutListItem extends Payout {
  invoice_number: string | null
  beneficiary_name: string | null
  beneficiary_country: string | null
  to_wallet: string | null
}

export interface ActivityItem {
  id: string
  ts: string
  kind: 'paid' | 'blocked' | 'held' | 'rejected' | 'registered' | 'uploaded' | 'info'
  text: string
  amount_eur: number | null
  tx_hash: string | null
  simulated: boolean
  invoice_id: string | null
}

export interface DashboardView {
  safeAddress: string | null
  balances: { eth: string; eurc: string; usdc: string; blockNumber: string; address: string } | null
  balancesError: string | null
  counts: { beneficiaries: number; activeBeneficiaries: number; queued: number; needsApproval: number; paid: number; paidEur: number; agentsRunning: number; agentsTotal: number }
  agents: { id: string; name: string; kind: string; status: string; used_eur: number; limit_eur: number; chips: { variant: 'chain' | 'agent'; label: string }[] }[]
  activity: ActivityItem[]
  comparison: { headline: string; subline: string; savedEur: number; savedBusinessDays: number; payouts: number; totalEur: number; periodLabel: string } | null
  execution: ExecutionModeInfo
  onboarding: { ready: boolean; onboarded: boolean; simulated: boolean; configured: boolean; step: OnboardingStep }
}

export interface EnvStatusItem {
  name: string
  configured: boolean
  masked: string
  group: 'llm' | 'data' | 'thyme' | 'chain' | 'app'
}

export interface SettingsView {
  safeAddress: string | null
  executor: PaymentExecutorName
  provider: 'bedrock' | 'anthropic' | 'mock'
  autoPayThreshold: number
  execution: ExecutionModeInfo
  thyme: ThymeOnboardingView
  env: EnvStatusItem[]
  boot: { startedAt: string; running: boolean; lastTickAt: string | null; lastError: string | null }
  databasePath: string
}

export interface ReportsView {
  month: string
  months: string[]
  comparison: {
    headline: string
    subline: string
    periodLabel: string
    payouts: number
    confirmed: number
    totalEur: number
    savedEur: number
    savedBusinessDays: number
    savedHours: number
    savedEurIfAllSwift: number
    swiftCorridors: number
    sepaCorridors: number
    mainnetEquivalentFeeEur: number
    avgSettlementSeconds: number | null
    lines: { payoutId: string; invoiceNo: string | null; beneficiary: string | null; country: string; sepa: boolean; amountEur: number; baselineLabel: string; baselineFeeEur: number; eurcFeeEur: number; savedEur: number; savedBusinessDays: number; sentence: string }[]
    sources: { key: string; label: string; value: string; source_url: string; fetched_on: string; note?: string }[]
  }
  audit: AuditEntry[]
  chain: { ok: boolean; records: number; message: string }
}
