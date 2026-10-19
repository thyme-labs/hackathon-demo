// Server-only typed CRUD over bun:sqlite. Every write that matters also goes to audit_log.
import { appendJsonl } from '../reports/audit'
import { getDb, newId, nowIso } from './sqlite'
import type {
  Agent,
  AuditActor,
  AuditEntry,
  Beneficiary,
  Invoice,
  InvoiceStatus,
  Payout,
  PayoutStatus,
  Setting,
} from './types'

type Row = Record<string, unknown>

function pickDefined<T extends Row>(patch: T): [string[], unknown[]] {
  const cols: string[] = []
  const vals: unknown[] = []
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue
    cols.push(k)
    vals.push(v)
  }
  return [cols, vals]
}

function insertRow(table: string, row: Row) {
  const [cols, vals] = pickDefined(row)
  const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
  getDb()
    .query(sql)
    .run(...(vals as never[]))
}

function updateRow(table: string, id: string, patch: Row): boolean {
  const [cols, vals] = pickDefined(patch)
  if (cols.length === 0) return false
  const sql = `UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`
  const res = getDb()
    .query(sql)
    .run(...(vals as never[]), id)
  return res.changes > 0
}

// ---------------------------------------------------------------- beneficiaries

export type NewBeneficiary = Partial<Omit<Beneficiary, 'id' | 'created_at'>> & { name: string; type: Beneficiary['type'] }

export const beneficiaries = {
  create(input: NewBeneficiary): Beneficiary {
    const id = newId()
    insertRow('beneficiaries', {
      id,
      name: input.name,
      type: input.type,
      country: input.country ?? null,
      tax_id: input.tax_id ?? null,
      wallet: input.wallet ? input.wallet.toLowerCase() : null,
      email: input.email ?? null,
      lei: input.lei ?? null,
      website: input.website ?? null,
      monthly_limit_eur: input.monthly_limit_eur ?? 0,
      status: input.status ?? 'new',
      trust_score: input.trust_score ?? 0,
      total_paid_eur: input.total_paid_eur ?? 0,
      last_paid_at: input.last_paid_at ?? null,
      ownership_proof_json: input.ownership_proof_json ?? null,
      created_at: nowIso(),
    })
    return beneficiaries.get(id) as Beneficiary
  },
  get(id: string): Beneficiary | null {
    return (getDb().query('SELECT * FROM beneficiaries WHERE id = ?').get(id) as Beneficiary | null) ?? null
  },
  byWallet(wallet: string): Beneficiary | null {
    return (
      (getDb()
        .query('SELECT * FROM beneficiaries WHERE lower(wallet) = lower(?) LIMIT 1')
        .get(wallet) as Beneficiary | null) ?? null
    )
  },
  byName(name: string): Beneficiary | null {
    return (
      (getDb()
        .query('SELECT * FROM beneficiaries WHERE lower(trim(name)) = lower(trim(?)) LIMIT 1')
        .get(name) as Beneficiary | null) ?? null
    )
  },
  list(status?: Beneficiary['status']): Beneficiary[] {
    if (status) {
      return getDb()
        .query('SELECT * FROM beneficiaries WHERE status = ? ORDER BY created_at DESC')
        .all(status) as Beneficiary[]
    }
    return getDb().query('SELECT * FROM beneficiaries ORDER BY created_at DESC').all() as Beneficiary[]
  },
  update(id: string, patch: Partial<Omit<Beneficiary, 'id' | 'created_at'>>): Beneficiary | null {
    const normalized = { ...patch, wallet: patch.wallet === undefined ? undefined : patch.wallet?.toLowerCase() ?? null }
    updateRow('beneficiaries', id, normalized)
    return beneficiaries.get(id)
  },
  /** Add a confirmed payment to the running totals. */
  recordPaid(id: string, amountEur: number, at = nowIso()): void {
    getDb()
      .query(
        'UPDATE beneficiaries SET total_paid_eur = total_paid_eur + ?, last_paid_at = ? WHERE id = ?',
      )
      .run(amountEur, at, id)
  },
  /** Sum of EUR paid (confirmed payouts) in the current calendar month. */
  paidThisMonthEur(id: string, now = new Date()): number {
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString()
    const row = getDb()
      .query(
        "SELECT COALESCE(SUM(amount_eur), 0) AS total FROM payouts WHERE beneficiary_id = ? AND status IN ('submitted', 'confirmed') AND created_at >= ?",
      )
      .get(id, monthStart) as { total: number }
    return row.total
  },
  remove(id: string): boolean {
    return getDb().query('DELETE FROM beneficiaries WHERE id = ?').run(id).changes > 0
  },
}

// ---------------------------------------------------------------- invoices

export type NewInvoice = Partial<Omit<Invoice, 'id' | 'created_at' | 'updated_at'>>
export type CreateInvoice = NewInvoice & { id?: string }

export const invoices = {
  create(input: CreateInvoice = {}): Invoice {
    const id = input.id ?? newId()
    const ts = nowIso()
    insertRow('invoices', {
      id,
      beneficiary_id: input.beneficiary_id ?? null,
      file_path: input.file_path ?? null,
      number: input.number ?? null,
      issue_date: input.issue_date ?? null,
      due_date: input.due_date ?? null,
      currency: input.currency ?? null,
      amount: input.amount ?? null,
      amount_eur: input.amount_eur ?? null,
      fx_rate: input.fx_rate ?? null,
      fx_source: input.fx_source ?? null,
      fx_at: input.fx_at ?? null,
      payee_name: input.payee_name ?? null,
      payee_wallet: input.payee_wallet ? input.payee_wallet.toLowerCase() : null,
      extracted_json: input.extracted_json ?? null,
      status: input.status ?? 'queued',
      score: input.score ?? null,
      checklist_json: input.checklist_json ?? null,
      decision_text: input.decision_text ?? null,
      created_at: ts,
      updated_at: ts,
    })
    return invoices.get(id) as Invoice
  },
  get(id: string): Invoice | null {
    return (getDb().query('SELECT * FROM invoices WHERE id = ?').get(id) as Invoice | null) ?? null
  },
  list(opts: { status?: InvoiceStatus; beneficiaryId?: string; limit?: number } = {}): Invoice[] {
    const where: string[] = []
    const args: unknown[] = []
    if (opts.status) {
      where.push('status = ?')
      args.push(opts.status)
    }
    if (opts.beneficiaryId) {
      where.push('beneficiary_id = ?')
      args.push(opts.beneficiaryId)
    }
    const sql = `SELECT * FROM invoices ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ?`
    args.push(opts.limit ?? 200)
    return getDb()
      .query(sql)
      .all(...(args as never[])) as Invoice[]
  },
  /** Everything the agent still has to look at, oldest first. */
  listQueue(): Invoice[] {
    return getDb()
      .query(
        "SELECT * FROM invoices WHERE status IN ('queued', 'investigating') ORDER BY created_at ASC",
      )
      .all() as Invoice[]
  },
  /** Oldest queued invoice, or null. Does not change status; call setInvoiceStatus(id, 'investigating'). */
  nextQueued(): Invoice | null {
    return (
      (getDb()
        .query("SELECT * FROM invoices WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1")
        .get() as Invoice | null) ?? null
    )
  },
  /** Other invoices sharing a number (duplicate check). */
  byNumber(number: string, excludeId?: string): Invoice[] {
    return getDb()
      .query('SELECT * FROM invoices WHERE number = ? AND id != ? ORDER BY created_at DESC')
      .all(number, excludeId ?? '') as Invoice[]
  },
  update(id: string, patch: NewInvoice): Invoice | null {
    const normalized = {
      ...patch,
      payee_wallet: patch.payee_wallet === undefined ? undefined : patch.payee_wallet?.toLowerCase() ?? null,
      updated_at: nowIso(),
    }
    updateRow('invoices', id, normalized)
    return invoices.get(id)
  },
  setStatus(id: string, status: InvoiceStatus, extra: Pick<NewInvoice, 'decision_text' | 'score' | 'checklist_json'> = {}): Invoice | null {
    updateRow('invoices', id, { status, ...extra, updated_at: nowIso() })
    return invoices.get(id)
  },
  remove(id: string): boolean {
    return getDb().query('DELETE FROM invoices WHERE id = ?').run(id).changes > 0
  },
}

export const listQueue = invoices.listQueue
export const nextQueued = invoices.nextQueued
export const setInvoiceStatus = invoices.setStatus

// ---------------------------------------------------------------- payouts

export type NewPayout = Partial<Omit<Payout, 'id' | 'created_at'>> & {
  invoice_id: string
  amount_eurc: string
  amount_eur: number
  executor: Payout['executor']
}

export const payouts = {
  create(input: NewPayout): Payout {
    const id = newId()
    insertRow('payouts', {
      id,
      invoice_id: input.invoice_id,
      beneficiary_id: input.beneficiary_id ?? null,
      amount_eurc: input.amount_eurc,
      amount_eur: input.amount_eur,
      currency: input.currency ?? 'EUR',
      fx_rate: input.fx_rate ?? null,
      cnb_rate: input.cnb_rate ?? null,
      cnb_valid_for: input.cnb_valid_for ?? null,
      amount_czk: input.amount_czk ?? null,
      executor: input.executor,
      thyme_execution_id: input.thyme_execution_id ?? null,
      tx_hash: input.tx_hash ?? null,
      status: input.status ?? 'pending',
      submitted_at: input.submitted_at ?? null,
      confirmed_at: input.confirmed_at ?? null,
      block_number: input.block_number ?? null,
      gas_used: input.gas_used ?? null,
      error: input.error ?? null,
      simulated: input.simulated ?? 0,
      effective_gas_price_wei: input.effective_gas_price_wei ?? null,
      created_at: nowIso(),
    })
    return payouts.get(id) as Payout
  },
  get(id: string): Payout | null {
    return (getDb().query('SELECT * FROM payouts WHERE id = ?').get(id) as Payout | null) ?? null
  },
  byInvoice(invoiceId: string): Payout[] {
    return getDb()
      .query('SELECT * FROM payouts WHERE invoice_id = ? ORDER BY created_at DESC')
      .all(invoiceId) as Payout[]
  },
  byExecutionId(executionId: string): Payout | null {
    return (
      (getDb()
        .query('SELECT * FROM payouts WHERE thyme_execution_id = ? LIMIT 1')
        .get(executionId) as Payout | null) ?? null
    )
  },
  list(opts: { status?: PayoutStatus; limit?: number } = {}): Payout[] {
    if (opts.status) {
      return getDb()
        .query('SELECT * FROM payouts WHERE status = ? ORDER BY created_at DESC LIMIT ?')
        .all(opts.status, opts.limit ?? 200) as Payout[]
    }
    return getDb()
      .query('SELECT * FROM payouts ORDER BY created_at DESC LIMIT ?')
      .all(opts.limit ?? 200) as Payout[]
  },
  /** Approved work for the Thyme Flow task: pending payouts whose invoice is approved/paying. */
  /** payee_wallet is the beneficiary's wallet ON FILE (never the one printed on the PDF). */
  listPendingForThyme(): (Payout & { payee_wallet: string | null; invoice_number: string | null })[] {
    return getDb()
      .query(
        `SELECT p.*, b.wallet AS payee_wallet, i.number AS invoice_number
         FROM payouts p JOIN invoices i ON i.id = p.invoice_id
         LEFT JOIN beneficiaries b ON b.id = p.beneficiary_id
         WHERE p.status = 'pending' AND p.executor = 'thyme' AND i.status IN ('approved', 'paying')
         ORDER BY p.created_at ASC`,
      )
      .all() as (Payout & { payee_wallet: string | null; invoice_number: string | null })[]
  },
  /** Pending payouts for the in-process payment agent (direct executor or Thyme trigger). */
  listPending(): (Payout & { invoice_status: string })[] {
    return getDb()
      .query(
        `SELECT p.*, i.status AS invoice_status FROM payouts p JOIN invoices i ON i.id = p.invoice_id
         WHERE p.status = 'pending' AND i.status IN ('approved', 'paying') ORDER BY p.created_at ASC`,
      )
      .all() as (Payout & { invoice_status: string })[]
  },
  /** Confirmed + in-flight EUR per beneficiary in the current calendar month (dashboard budget bars). */
  paidThisMonthByBeneficiary(now = new Date()): Record<string, number> {
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString()
    const rows = getDb()
      .query(
        "SELECT beneficiary_id, COALESCE(SUM(amount_eur), 0) AS total FROM payouts WHERE status IN ('submitted', 'confirmed') AND created_at >= ? AND beneficiary_id IS NOT NULL GROUP BY beneficiary_id",
      )
      .all(monthStart) as { beneficiary_id: string; total: number }[]
    return Object.fromEntries(rows.map((r) => [r.beneficiary_id, r.total]))
  },
  update(id: string, patch: Partial<Omit<Payout, 'id' | 'created_at'>>): Payout | null {
    updateRow('payouts', id, patch)
    return payouts.get(id)
  },
  setStatus(id: string, status: PayoutStatus, extra: Partial<Omit<Payout, 'id' | 'created_at' | 'status'>> = {}): Payout | null {
    updateRow('payouts', id, { status, ...extra })
    return payouts.get(id)
  },
}

// ---------------------------------------------------------------- agents

export const agents = {
  upsert(input: Omit<Agent, 'last_run_at'> & { last_run_at?: string | null }): Agent {
    getDb()
      .query(
        `INSERT INTO agents (id, name, kind, status, config_json, last_run_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, kind = excluded.kind, status = excluded.status,
           config_json = excluded.config_json, last_run_at = COALESCE(excluded.last_run_at, agents.last_run_at)`,
      )
      .run(input.id, input.name, input.kind, input.status, input.config_json ?? null, input.last_run_at ?? null)
    return agents.get(input.id) as Agent
  },
  get(id: string): Agent | null {
    return (getDb().query('SELECT * FROM agents WHERE id = ?').get(id) as Agent | null) ?? null
  },
  list(): Agent[] {
    return getDb().query('SELECT * FROM agents ORDER BY name ASC').all() as Agent[]
  },
  setStatus(id: string, status: Agent['status']): Agent | null {
    updateRow('agents', id, { status })
    return agents.get(id)
  },
  touch(id: string, at = nowIso()): void {
    updateRow('agents', id, { last_run_at: at })
  },
  update(id: string, patch: Partial<Omit<Agent, 'id'>>): Agent | null {
    updateRow('agents', id, patch)
    return agents.get(id)
  },
}

// ---------------------------------------------------------------- audit log

export interface AppendAuditInput {
  actor: AuditActor
  event: string
  invoiceId?: string | null
  beneficiaryId?: string | null
  details?: unknown
}

export function appendAudit(input: AppendAuditInput): AuditEntry {
  mirrorAuditToJsonl(input)
  const res = getDb()
    .query(
      'INSERT INTO audit_log (ts, actor, invoice_id, beneficiary_id, event, details_json) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(
      nowIso(),
      input.actor,
      input.invoiceId ?? null,
      input.beneficiaryId ?? null,
      input.event,
      input.details === undefined ? null : JSON.stringify(input.details),
    )
  return getDb()
    .query('SELECT * FROM audit_log WHERE id = ?')
    .get(Number(res.lastInsertRowid)) as AuditEntry
}

/** Best-effort mirror into the sha256 hash-chained JSONL (src/lib/reports/audit.ts). Never throws. */
function mirrorAuditToJsonl(input: AppendAuditInput): void {
  try {
    const details = input.details && typeof input.details === 'object' ? (input.details as Record<string, unknown>) : input.details === undefined ? {} : { value: input.details }
    appendJsonl({ actor: input.actor, event: input.event, invoice_id: input.invoiceId ?? null, beneficiary_id: input.beneficiaryId ?? null, details })
  } catch {
    // the SQLite row is the source of truth; the JSONL is an export
  }
}

export const audit = {
  append: appendAudit,
  list(opts: { invoiceId?: string; beneficiaryId?: string; limit?: number } = {}): AuditEntry[] {
    const where: string[] = []
    const args: unknown[] = []
    if (opts.invoiceId) {
      where.push('invoice_id = ?')
      args.push(opts.invoiceId)
    }
    if (opts.beneficiaryId) {
      where.push('beneficiary_id = ?')
      args.push(opts.beneficiaryId)
    }
    args.push(opts.limit ?? 500)
    return getDb()
      .query(
        `SELECT * FROM audit_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`,
      )
      .all(...(args as never[])) as AuditEntry[]
  },
}

// ---------------------------------------------------------------- settings

export const settings = {
  get(key: string): string | null {
    const row = getDb().query('SELECT value FROM settings WHERE key = ?').get(key) as Setting | null
    return row?.value ?? null
  },
  set(key: string, value: string | null): void {
    getDb()
      .query('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value)
  },
  all(): Record<string, string | null> {
    const rows = getDb().query('SELECT key, value FROM settings').all() as Setting[]
    return Object.fromEntries(rows.map((r) => [r.key, r.value]))
  },
  remove(key: string): void {
    getDb().query('DELETE FROM settings WHERE key = ?').run(key)
  },
}

// ---------------------------------------------------------------- dashboard aggregates

export function dashboardCounts() {
  const db = getDb()
  const one = (sql: string) => (db.query(sql).get() as { n: number }).n
  return {
    beneficiaries: one('SELECT COUNT(*) AS n FROM beneficiaries'),
    activeBeneficiaries: one("SELECT COUNT(*) AS n FROM beneficiaries WHERE status = 'active'"),
    queued: one("SELECT COUNT(*) AS n FROM invoices WHERE status IN ('queued', 'investigating')"),
    needsApproval: one("SELECT COUNT(*) AS n FROM invoices WHERE status = 'needs_approval'"),
    paid: one("SELECT COUNT(*) AS n FROM invoices WHERE status = 'paid'"),
    paidEur: one("SELECT COALESCE(SUM(amount_eur), 0) AS n FROM payouts WHERE status = 'confirmed'"),
    agentsRunning: one("SELECT COUNT(*) AS n FROM agents WHERE status = 'running'"),
    agentsTotal: one('SELECT COUNT(*) AS n FROM agents'),
  }
}

export { getDb, newId, nowIso } from './sqlite'
