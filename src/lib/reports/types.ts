// Row shapes used by the reports module. They mirror the SQLite columns in
// src/lib/store/schema.sql (snake_case) so repo rows can be passed through
// unchanged. Only the fields the reports read are declared; extra columns are fine.

export type BeneficiaryType = 'person' | 'company';
export type BeneficiaryStatus = 'new' | 'active' | 'paused' | 'blocked';

export interface BeneficiaryRow {
  id: string;
  name: string;
  type: BeneficiaryType;
  country: string | null; // ISO-3166 alpha-2
  tax_id?: string | null;
  wallet: string | null;
  email?: string | null;
  lei?: string | null;
  website?: string | null;
  monthly_limit_eur?: number | null;
  status: BeneficiaryStatus;
  trust_score?: number | null;
  total_paid_eur?: number | null;
  last_paid_at?: string | null;
  ownership_proof_json?: string | null;
  created_at?: string;
}

export type InvoiceStatus =
  | 'queued'
  | 'investigating'
  | 'needs_approval'
  | 'approved'
  | 'rejected'
  | 'paying'
  | 'paid'
  | 'failed';

export interface InvoiceRow {
  id: string;
  beneficiary_id?: string | null;
  file_path?: string | null;
  number: string | null;
  issue_date?: string | null; // YYYY-MM-DD
  due_date?: string | null; // YYYY-MM-DD
  currency: string | null; // ISO-4217 of the invoice
  amount: number | null; // in invoice currency
  amount_eur?: number | null;
  fx_rate?: number | null; // invoice currency -> EUR (1 unit = fx_rate EUR)
  fx_source?: string | null;
  fx_at?: string | null; // ISO timestamp
  payee_name?: string | null;
  payee_wallet?: string | null;
  extracted_json?: string | null;
  status: InvoiceStatus;
  score?: number | null;
  checklist_json?: string | null;
  decision_text?: string | null;
  created_at?: string;
  updated_at?: string;
}

export type PayoutExecutor = 'thyme' | 'direct';
export type PayoutStatus = 'pending' | 'submitted' | 'confirmed' | 'failed' | 'reverted';

export interface PayoutRow {
  id: string;
  invoice_id: string;
  beneficiary_id: string | null;
  /** Wallet actually paid (an approved beneficiary wallet); falls back to the primary wallet when absent. */
  to_wallet?: string | null;
  /** Store convention: EURC base units (6 dp) as a decimal string; a human-unit number or "1250.00" string is also accepted (see eurcHumanAmount). */
  amount_eurc: string | number;
  amount_eur: number;
  currency?: string | null; // invoice currency
  fx_rate?: number | null; // invoice currency -> EUR
  cnb_rate?: number | null; // CZK per 1 EUR
  cnb_valid_for?: string | null; // YYYY-MM-DD
  amount_czk?: number | null;
  executor: PayoutExecutor;
  thyme_execution_id?: string | null;
  tx_hash?: string | null;
  status: PayoutStatus;
  submitted_at?: string | null;
  confirmed_at?: string | null;
  block_number?: number | null;
  gas_used?: number | null;
  error?: string | null;
  created_at?: string;
}

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'skip';
export type CheckEnforcement = 'chain' | 'agent';

export interface ChecklistItem {
  id: string;
  label: string;
  status: CheckStatus;
  enforcement: CheckEnforcement;
  weight: number;
  evidence: string;
  source: string;
  at: string | null; // ISO timestamp
  dataset_id?: string | null;
  dataset_version?: string | null;
}

export type AuditActor = 'agent' | 'owner' | 'thyme' | 'chain';

/** Network fee facts the payouts table does not carry; supplied by the caller from the receipt. */
export interface NetworkFee {
  gasUsed?: number | null;
  effectiveGasPriceWei?: bigint | number | string | null;
  feeEth?: number | null;
  feeEur?: number | null;
  ethEur?: number | null;
}

/** A single sourced assumption, rendered in the "Assumptions and sources" drawer. */
export interface Assumption {
  key: string;
  label: string;
  value: string;
  source_url: string;
  fetched_on: string;
  note?: string;
}

export const SEPOLIA_CHAIN_ID = 11155111;
export const SEPOLIA_ETHERSCAN = 'https://sepolia.etherscan.io';
export const EURC_SEPOLIA = '0x08210F9170F89Ab7658F0B5E3fF39b0E03C594D4';
export const EURC_DECIMALS = 6;
