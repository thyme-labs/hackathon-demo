// Shapes returned by the server functions to the UI. Types only: safe to import anywhere.
import type { ChecklistSnapshot } from '../agent/types'
import type { Agent, AuditEntry, Beneficiary, Invoice, Payout } from '../store/types'
import type { MandatePlan, SafeTxDto } from './mandate'

export type { ChecklistSnapshot, MandatePlan, SafeTxDto }

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
  mode: 'direct' | 'thyme' | 'simulated'
  reason: string
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
  mandate: { safeAddress: string | null; rolesProxy: string | null; roleKey: string | null }
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

export interface AgentView extends Agent {
  config: Record<string, unknown>
  cost_usd: number
  llm_calls: number
  runs: AuditEntry[]
  executor: 'thyme' | 'direct'
  execution: ExecutionModeInfo
  thyme: { triggerMode: 'webhook' | 'management-run' | 'none'; executableId: string | null; consoleUrl: string | null }
  agentAddress: string | null
  rolesProxy: string | null
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
  agentAddress: string | null
  balances: { eth: string; eurc: string; usdc: string; blockNumber: string; address: string } | null
  balancesError: string | null
  counts: { beneficiaries: number; activeBeneficiaries: number; queued: number; needsApproval: number; paid: number; paidEur: number; agentsRunning: number; agentsTotal: number }
  agents: { id: string; name: string; kind: string; status: string; used_eur: number; limit_eur: number; chips: { variant: 'chain' | 'agent'; label: string }[] }[]
  activity: ActivityItem[]
  comparison: { headline: string; subline: string; savedEur: number; savedBusinessDays: number; payouts: number; totalEur: number; periodLabel: string } | null
  execution: ExecutionModeInfo
}

export interface EnvStatusItem {
  name: string
  configured: boolean
  masked: string
  group: 'llm' | 'data' | 'thyme' | 'chain' | 'app'
}

export interface SettingsView {
  safeAddress: string | null
  rolesProxy: string | null
  roleKey: string | null
  mandateId: string | null
  installTxHash: string | null
  agentAddress: string | null
  agentFromKey: boolean
  executor: 'thyme' | 'direct'
  provider: 'bedrock' | 'anthropic' | 'mock'
  autoPayThreshold: number
  execution: ExecutionModeInfo
  thymeTriggerMode: 'webhook' | 'management-run' | 'none'
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
