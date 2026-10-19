-- Thyme Payroll domain model. Applied with CREATE TABLE IF NOT EXISTS on boot.
-- Schema changes after the first deploy go to src/lib/store/migrations/NNN_name.sql.

CREATE TABLE IF NOT EXISTS beneficiaries (
  id                   TEXT PRIMARY KEY,
  name                 TEXT NOT NULL,
  type                 TEXT NOT NULL CHECK (type IN ('person', 'company')),
  country              TEXT,
  tax_id               TEXT,
  wallet               TEXT,
  email                TEXT,
  lei                  TEXT,
  website              TEXT,
  monthly_limit_eur    REAL NOT NULL DEFAULT 0,
  status               TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'active', 'paused', 'blocked')),
  trust_score          INTEGER NOT NULL DEFAULT 0 CHECK (trust_score BETWEEN 0 AND 100),
  total_paid_eur       REAL NOT NULL DEFAULT 0,
  last_paid_at         TEXT,
  ownership_proof_json TEXT,
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_beneficiaries_wallet ON beneficiaries (wallet);
CREATE INDEX IF NOT EXISTS idx_beneficiaries_status ON beneficiaries (status);

CREATE TABLE IF NOT EXISTS invoices (
  id              TEXT PRIMARY KEY,
  beneficiary_id  TEXT REFERENCES beneficiaries (id),
  file_path       TEXT,
  number          TEXT,
  issue_date      TEXT,
  due_date        TEXT,
  currency        TEXT,
  amount          REAL,
  amount_eur      REAL,
  fx_rate         REAL,
  fx_source       TEXT,
  fx_at           TEXT,
  payee_name      TEXT,
  payee_wallet    TEXT,
  extracted_json  TEXT,
  status          TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'investigating', 'needs_approval', 'approved', 'rejected', 'paying', 'paid', 'failed')),
  score           INTEGER,
  checklist_json  TEXT,
  decision_text   TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices (status, created_at);
CREATE INDEX IF NOT EXISTS idx_invoices_beneficiary ON invoices (beneficiary_id);
CREATE INDEX IF NOT EXISTS idx_invoices_number ON invoices (number);

CREATE TABLE IF NOT EXISTS payouts (
  id                 TEXT PRIMARY KEY,
  invoice_id         TEXT NOT NULL REFERENCES invoices (id),
  beneficiary_id     TEXT REFERENCES beneficiaries (id),
  amount_eurc        TEXT NOT NULL,
  amount_eur         REAL NOT NULL,
  currency           TEXT NOT NULL DEFAULT 'EUR',
  fx_rate            REAL,
  cnb_rate           REAL,
  cnb_valid_for      TEXT,
  amount_czk         REAL,
  -- Thyme Flow is the only rail; 'direct' only remains for rows written before the agent key was retired.
  -- A payout recorded without a chain transaction carries simulated = 1 (migration 001), not another executor.
  executor           TEXT NOT NULL CHECK (executor IN ('thyme', 'direct')),
  thyme_execution_id TEXT,
  tx_hash            TEXT,
  status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'submitted', 'confirmed', 'failed', 'reverted')),
  submitted_at       TEXT,
  confirmed_at       TEXT,
  block_number       INTEGER,
  gas_used           INTEGER,
  error              TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_payouts_status ON payouts (status, created_at);
CREATE INDEX IF NOT EXISTS idx_payouts_invoice ON payouts (invoice_id);
CREATE INDEX IF NOT EXISTS idx_payouts_execution ON payouts (thyme_execution_id);

CREATE TABLE IF NOT EXISTS agents (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('compliance', 'payment')),
  status      TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'paused')),
  config_json TEXT,
  last_run_at TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  ts             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  actor          TEXT NOT NULL CHECK (actor IN ('agent', 'owner', 'thyme', 'chain')),
  invoice_id     TEXT,
  beneficiary_id TEXT,
  event          TEXT NOT NULL,
  details_json   TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_invoice ON audit_log (invoice_id, ts);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log (ts);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);
