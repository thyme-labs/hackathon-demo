// Server-only typed CRUD over bun:sqlite, scoped to ONE tenant. Every write that matters also goes to audit_log.
//
//   const { invoices } = forTenant(tenantId)          // explicit: server fns, API routes, the worker loop
//   import { invoices } from '../store/repos'         // bound to the tenant of the current runWithTenant() context
//
// The bound exports resolve the tenant on every call and throw when no tenant context is set, so deep modules
// (payments runner, agent service, Thyme onboarding, reports) keep their imports and still never cross tenants.
import { dirname, join } from 'node:path'
import { appendJsonl, auditLogPath } from '../reports/audit'
import { getDb, newId, nowIso } from './sqlite'
import { currentTenant, FOUNDER_TENANT_FALLBACK, GLOBAL_TENANT, tenantSlug } from './tenant'
import type {
  Agent,
  AuditActor,
  AuditEntry,
  Beneficiary,
  BeneficiaryWallet,
  BeneficiaryWalletSource,
  Invoice,
  InvoiceStatus,
  Payout,
  PayoutStatus,
  Setting,
} from './types'

type Row = Record<string, unknown>

/** Tables carrying tenant_id directly; beneficiary_wallets is scoped through its beneficiary (migration 005). */
const TENANT_TABLES = new Set(['beneficiaries', 'invoices', 'payouts', 'agents', 'audit_log', 'settings'])
const WALLET_SCOPE = 'beneficiary_id IN (SELECT id FROM beneficiaries WHERE tenant_id = ?)'

function scopeSql(table: string): string {
  return TENANT_TABLES.has(table) ? 'tenant_id = ?' : WALLET_SCOPE
}

function pickDefined<T extends Row>(patch: T): [string[], unknown[]] {
  const cols: string[] = []
  const vals: unknown[] = []
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || k === 'tenant_id') continue
    cols.push(k)
    vals.push(v)
  }
  return [cols, vals]
}

export type NewBeneficiary = Partial<Omit<Beneficiary, 'id' | 'tenant_id' | 'created_at'>> & { name: string; type: Beneficiary['type'] }

export interface EnsureApprovedWalletInput {
  beneficiaryId: string
  wallet: string
  label?: string | null
  source?: BeneficiaryWalletSource
  /** undefined keeps the proof already on the row; null clears it; a proof for another wallet is ignored. */
  ownershipProofJson?: string | null
  /** Make it the primary wallet (mirrored into beneficiaries.wallet). */
  primary?: boolean
  approvedBy?: string
}

export interface ProposeWalletInput {
  beneficiaryId: string
  wallet: string
  label?: string | null
  source: BeneficiaryWalletSource
}

export type NewInvoice = Partial<Omit<Invoice, 'id' | 'tenant_id' | 'created_at' | 'updated_at'>>
export type CreateInvoice = NewInvoice & { id?: string }

export type NewPayout = Partial<Omit<Payout, 'id' | 'tenant_id' | 'created_at'>> & {
  invoice_id: string
  amount_eurc: string
  amount_eur: number
  executor: Payout['executor']
}

export interface AppendAuditInput {
  actor: AuditActor
  event: string
  invoiceId?: string | null
  beneficiaryId?: string | null
  details?: unknown
}

const WALLET_ORDER = "is_primary DESC, CASE status WHEN 'approved' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END, created_at ASC"

/** A stored proof only counts for the wallet it was signed for. undefined = leave the column alone. */
function proofForWallet(wallet: string, json: string | null | undefined): string | null | undefined {
  if (json === undefined) return undefined
  if (!json) return null
  try {
    const parsed = JSON.parse(json) as { wallet?: string }
    return typeof parsed.wallet === 'string' && parsed.wallet.toLowerCase() === wallet ? json : null
  } catch {
    return null
  }
}

function buildRepos(tenantId: string) {
  const T = tenantId

  function insertRow(table: string, row: Row) {
    const [cols, vals] = pickDefined(TENANT_TABLES.has(table) ? { tenant_id: '', ...row } : row)
    if (TENANT_TABLES.has(table)) {
      cols.unshift('tenant_id')
      vals.unshift(T)
    }
    const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
    getDb()
      .query(sql)
      .run(...(vals as never[]))
  }

  function updateRow(table: string, id: string, patch: Row): boolean {
    const [cols, vals] = pickDefined(patch)
    if (cols.length === 0) return false
    const sql = `UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ? AND ${scopeSql(table)}`
    const res = getDb()
      .query(sql)
      .run(...(vals as never[]), id, T)
    return res.changes > 0
  }

  // ---------------------------------------------------------------- beneficiaries

  const beneficiaries = {
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
      // The registered wallet is the approved primary wallet (beneficiary_wallets, migration 004).
      if (input.wallet) {
        beneficiaryWallets.ensureApproved({ beneficiaryId: id, wallet: input.wallet, label: 'primary', source: 'registration', ownershipProofJson: input.ownership_proof_json ?? null, primary: true, approvedBy: 'owner' })
      }
      return beneficiaries.get(id) as Beneficiary
    },
    get(id: string): Beneficiary | null {
      return (getDb().query('SELECT * FROM beneficiaries WHERE id = ? AND tenant_id = ?').get(id, T) as Beneficiary | null) ?? null
    },
    byWallet(wallet: string): Beneficiary | null {
      return (
        (getDb()
          .query('SELECT * FROM beneficiaries WHERE lower(wallet) = lower(?) AND tenant_id = ? LIMIT 1')
          .get(wallet, T) as Beneficiary | null) ?? null
      )
    },
    byName(name: string): Beneficiary | null {
      return (
        (getDb()
          .query('SELECT * FROM beneficiaries WHERE lower(trim(name)) = lower(trim(?)) AND tenant_id = ? LIMIT 1')
          .get(name, T) as Beneficiary | null) ?? null
      )
    },
    list(status?: Beneficiary['status']): Beneficiary[] {
      if (status) {
        return getDb()
          .query('SELECT * FROM beneficiaries WHERE tenant_id = ? AND status = ? ORDER BY created_at DESC')
          .all(T, status) as Beneficiary[]
      }
      return getDb().query('SELECT * FROM beneficiaries WHERE tenant_id = ? ORDER BY created_at DESC').all(T) as Beneficiary[]
    },
    update(id: string, patch: Partial<Omit<Beneficiary, 'id' | 'tenant_id' | 'created_at'>>): Beneficiary | null {
      const normalized = { ...patch, wallet: patch.wallet === undefined ? undefined : patch.wallet?.toLowerCase() ?? null }
      updateRow('beneficiaries', id, normalized)
      // Keep beneficiary_wallets in sync: a wallet written here is the owner's registered (approved, primary) wallet.
      if (normalized.wallet) {
        beneficiaryWallets.ensureApproved({ beneficiaryId: id, wallet: normalized.wallet, label: 'primary', source: 'registration', ownershipProofJson: patch.ownership_proof_json, primary: true, approvedBy: 'owner' })
      } else if (patch.ownership_proof_json !== undefined) {
        beneficiaryWallets.syncPrimaryProof(id, patch.ownership_proof_json ?? null)
      }
      return beneficiaries.get(id)
    },
    /** Add a confirmed payment to the running totals. */
    recordPaid(id: string, amountEur: number, at = nowIso()): void {
      getDb()
        .query('UPDATE beneficiaries SET total_paid_eur = total_paid_eur + ?, last_paid_at = ? WHERE id = ? AND tenant_id = ?')
        .run(amountEur, at, id, T)
    },
    /** Sum of EUR paid (confirmed payouts) in the current calendar month. */
    paidThisMonthEur(id: string, now = new Date()): number {
      const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString()
      const row = getDb()
        .query(
          "SELECT COALESCE(SUM(amount_eur), 0) AS total FROM payouts WHERE beneficiary_id = ? AND tenant_id = ? AND status IN ('submitted', 'confirmed') AND created_at >= ?",
        )
        .get(id, T, monthStart) as { total: number }
      return row.total
    },
    remove(id: string): boolean {
      return getDb().query('DELETE FROM beneficiaries WHERE id = ? AND tenant_id = ?').run(id, T).changes > 0
    },
  }

  // ---------------------------------------------------------------- beneficiary wallets (migration 004)

  /** Marks `row` as the primary wallet (or none) and mirrors it into beneficiaries.wallet / ownership_proof_json. */
  function mirrorPrimaryWallet(beneficiaryId: string, row: BeneficiaryWallet | null): void {
    getDb()
      .query(`UPDATE beneficiary_wallets SET is_primary = CASE WHEN id = ? THEN 1 ELSE 0 END WHERE beneficiary_id = ? AND ${WALLET_SCOPE}`)
      .run(row?.id ?? '', beneficiaryId, T)
    updateRow('beneficiaries', beneficiaryId, { wallet: row?.wallet ?? null, ownership_proof_json: row?.ownership_proof_json ?? null })
  }

  /**
   * Wallets a beneficiary may be paid at. Only 'approved' rows are ever handed to the rail; a wallet printed on an
   * invoice of a known payee lands here as 'pending' until the owner approves it explicitly (BEC vector).
   */
  const beneficiaryWallets = {
    listByBeneficiary(beneficiaryId: string): BeneficiaryWallet[] {
      return getDb()
        .query(`SELECT * FROM beneficiary_wallets WHERE beneficiary_id = ? AND ${WALLET_SCOPE} ORDER BY ${WALLET_ORDER}`)
        .all(beneficiaryId, T) as BeneficiaryWallet[]
    },
    get(id: string): BeneficiaryWallet | null {
      return (getDb().query(`SELECT * FROM beneficiary_wallets WHERE id = ? AND ${WALLET_SCOPE}`).get(id, T) as BeneficiaryWallet | null) ?? null
    },
    find(beneficiaryId: string, wallet: string): BeneficiaryWallet | null {
      return (
        (getDb()
          .query(`SELECT * FROM beneficiary_wallets WHERE beneficiary_id = ? AND wallet = lower(?) AND ${WALLET_SCOPE} LIMIT 1`)
          .get(beneficiaryId, wallet, T) as BeneficiaryWallet | null) ?? null
      )
    },
    /** Approved wallets, primary first. */
    approvedFor(beneficiaryId: string): BeneficiaryWallet[] {
      return getDb()
        .query(`SELECT * FROM beneficiary_wallets WHERE beneficiary_id = ? AND status = 'approved' AND ${WALLET_SCOPE} ORDER BY is_primary DESC, created_at ASC`)
        .all(beneficiaryId, T) as BeneficiaryWallet[]
    },
    /** An approved row for this wallet on any beneficiary of the tenant (registry match by a secondary wallet). */
    findApproved(wallet: string): BeneficiaryWallet | null {
      return (
        (getDb()
          .query(`SELECT * FROM beneficiary_wallets WHERE wallet = lower(?) AND status = 'approved' AND ${WALLET_SCOPE} ORDER BY is_primary DESC, created_at ASC LIMIT 1`)
          .get(wallet, T) as BeneficiaryWallet | null) ?? null
      )
    },
    isApproved(beneficiaryId: string, wallet: string): boolean {
      return beneficiaryWallets.find(beneficiaryId, wallet)?.status === 'approved'
    },
    /**
     * The wallet a payout goes to: the wallet printed on the invoice when it is approved, else the primary approved
     * wallet, else the oldest approved one. Never a pending or revoked wallet; null when nothing is approved.
     */
    selectForPayout(beneficiaryId: string, invoiceWallet: string | null | undefined): string | null {
      const approved = beneficiaryWallets.approvedFor(beneficiaryId)
      if (approved.length === 0) return null
      const printed = invoiceWallet?.toLowerCase() ?? null
      const hit = printed ? approved.find((w) => w.wallet === printed) : undefined
      return (hit ?? approved.find((w) => w.is_primary === 1) ?? approved[0]).wallet
    },
    /** Records a wallet as pending unless the beneficiary already has a row for it (any status). */
    propose(input: ProposeWalletInput): { wallet: BeneficiaryWallet; created: boolean } {
      const wallet = input.wallet.toLowerCase()
      if (!beneficiaries.get(input.beneficiaryId)) throw new Error('beneficiary not found')
      const existing = beneficiaryWallets.find(input.beneficiaryId, wallet)
      if (existing) return { wallet: existing, created: false }
      const id = newId()
      insertRow('beneficiary_wallets', {
        id,
        beneficiary_id: input.beneficiaryId,
        wallet,
        label: input.label ?? null,
        status: 'pending',
        is_primary: 0,
        ownership_proof_json: null,
        source: input.source,
        approved_by: null,
        approved_at: null,
        created_at: nowIso(),
      })
      return { wallet: beneficiaryWallets.get(id) as BeneficiaryWallet, created: true }
    },
    /** Upserts an approved row (registration path); optionally makes it the primary wallet. */
    ensureApproved(input: EnsureApprovedWalletInput): BeneficiaryWallet {
      const wallet = input.wallet.toLowerCase()
      if (!beneficiaries.get(input.beneficiaryId)) throw new Error('beneficiary not found')
      const proof = proofForWallet(wallet, input.ownershipProofJson)
      const existing = beneficiaryWallets.find(input.beneficiaryId, wallet)
      const ts = nowIso()
      if (existing) {
        updateRow('beneficiary_wallets', existing.id, {
          status: 'approved',
          label: existing.label ?? input.label ?? null,
          ownership_proof_json: proof,
          approved_by: existing.status === 'approved' ? existing.approved_by : (input.approvedBy ?? 'owner'),
          approved_at: existing.status === 'approved' ? existing.approved_at : ts,
        })
      } else {
        insertRow('beneficiary_wallets', {
          id: newId(),
          beneficiary_id: input.beneficiaryId,
          wallet,
          label: input.label ?? null,
          status: 'approved',
          is_primary: 0,
          ownership_proof_json: proof ?? null,
          source: input.source ?? 'manual',
          approved_by: input.approvedBy ?? 'owner',
          approved_at: ts,
          created_at: ts,
        })
      }
      const row = beneficiaryWallets.find(input.beneficiaryId, wallet) as BeneficiaryWallet
      if (input.primary) mirrorPrimaryWallet(input.beneficiaryId, row)
      return row
    },
    /** Owner approval. Becomes the primary wallet when the beneficiary has no approved primary yet. */
    approve(id: string, approvedBy = 'owner'): BeneficiaryWallet | null {
      const row = beneficiaryWallets.get(id)
      if (!row) return null
      if (row.status !== 'approved') updateRow('beneficiary_wallets', id, { status: 'approved', approved_by: approvedBy, approved_at: nowIso() })
      const fresh = beneficiaryWallets.get(id) as BeneficiaryWallet
      if (!beneficiaryWallets.approvedFor(fresh.beneficiary_id).some((w) => w.is_primary === 1)) mirrorPrimaryWallet(fresh.beneficiary_id, fresh)
      return beneficiaryWallets.get(id)
    },
    /** Never paid again. A revoked primary hands the primary role to the next approved wallet (or none). */
    revoke(id: string): BeneficiaryWallet | null {
      const row = beneficiaryWallets.get(id)
      if (!row) return null
      updateRow('beneficiary_wallets', id, { status: 'revoked', is_primary: 0 })
      if (row.is_primary === 1) mirrorPrimaryWallet(row.beneficiary_id, beneficiaryWallets.approvedFor(row.beneficiary_id)[0] ?? null)
      return beneficiaryWallets.get(id)
    },
    /** Only an approved wallet can be primary; mirrored into beneficiaries.wallet. */
    setPrimary(id: string): BeneficiaryWallet | null {
      const row = beneficiaryWallets.get(id)
      if (!row) return null
      if (row.status !== 'approved') throw new Error('only an approved wallet can be the primary wallet')
      mirrorPrimaryWallet(row.beneficiary_id, row)
      return beneficiaryWallets.get(id)
    },
    /** beneficiaries.ownership_proof_json changed without a wallet change: copy it onto the primary row when it fits. */
    syncPrimaryProof(beneficiaryId: string, proofJson: string | null): void {
      const primary = beneficiaryWallets.approvedFor(beneficiaryId).find((w) => w.is_primary === 1)
      if (!primary) return
      updateRow('beneficiary_wallets', primary.id, { ownership_proof_json: proofForWallet(primary.wallet, proofJson) ?? null })
    },
    update(id: string, patch: Partial<Pick<BeneficiaryWallet, 'label' | 'ownership_proof_json'>>): BeneficiaryWallet | null {
      updateRow('beneficiary_wallets', id, patch)
      return beneficiaryWallets.get(id)
    },
    /** Confirmed EUR per wallet actually paid (payouts.to_wallet), for the Beneficiaries page. */
    paidTotals(beneficiaryId: string): Record<string, { eur: number; count: number }> {
      const rows = getDb()
        .query(
          "SELECT lower(to_wallet) AS wallet, COALESCE(SUM(amount_eur), 0) AS eur, COUNT(*) AS count FROM payouts WHERE beneficiary_id = ? AND tenant_id = ? AND status = 'confirmed' AND to_wallet IS NOT NULL GROUP BY lower(to_wallet)",
        )
        .all(beneficiaryId, T) as { wallet: string; eur: number; count: number }[]
      return Object.fromEntries(rows.map((r) => [r.wallet, { eur: r.eur, count: r.count }]))
    },
  }

  // ---------------------------------------------------------------- invoices

  const invoices = {
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
        hold: input.hold ?? 0,
        override: input.override ?? 0,
        created_at: ts,
        updated_at: ts,
      })
      return invoices.get(id) as Invoice
    },
    get(id: string): Invoice | null {
      return (getDb().query('SELECT * FROM invoices WHERE id = ? AND tenant_id = ?').get(id, T) as Invoice | null) ?? null
    },
    list(opts: { status?: InvoiceStatus; beneficiaryId?: string; limit?: number } = {}): Invoice[] {
      const where: string[] = ['tenant_id = ?']
      const args: unknown[] = [T]
      if (opts.status) {
        where.push('status = ?')
        args.push(opts.status)
      }
      if (opts.beneficiaryId) {
        where.push('beneficiary_id = ?')
        args.push(opts.beneficiaryId)
      }
      const sql = `SELECT * FROM invoices WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ?`
      args.push(opts.limit ?? 200)
      return getDb()
        .query(sql)
        .all(...(args as never[])) as Invoice[]
    },
    /** Everything the agent still has to look at, oldest first. */
    listQueue(): Invoice[] {
      return getDb()
        .query("SELECT * FROM invoices WHERE tenant_id = ? AND status IN ('queued', 'investigating') ORDER BY created_at ASC")
        .all(T) as Invoice[]
    },
    /** Oldest queued invoice, or null. Does not change status; call setInvoiceStatus(id, 'investigating'). */
    nextQueued(): Invoice | null {
      return (
        (getDb()
          .query("SELECT * FROM invoices WHERE tenant_id = ? AND status = 'queued' ORDER BY created_at ASC LIMIT 1")
          .get(T) as Invoice | null) ?? null
      )
    },
    /** Other invoices sharing a number (duplicate check). */
    byNumber(number: string, excludeId?: string): Invoice[] {
      return getDb()
        .query('SELECT * FROM invoices WHERE number = ? AND id != ? AND tenant_id = ? ORDER BY created_at DESC')
        .all(number, excludeId ?? '', T) as Invoice[]
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
      return getDb().query('DELETE FROM invoices WHERE id = ? AND tenant_id = ?').run(id, T).changes > 0
    },
  }

  // ---------------------------------------------------------------- payouts

  const payouts = {
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
        // A fresh attempt number per invoice keeps the Thyme Idempotency-Key unique across retries.
        attempt: input.attempt ?? payouts.nextAttempt(input.invoice_id),
        override: input.override ?? 0,
        to_wallet: input.to_wallet ? input.to_wallet.toLowerCase() : null,
        created_at: nowIso(),
      })
      return payouts.get(id) as Payout
    },
    /** 1 + the highest attempt recorded for this invoice (the Idempotency-Key suffix of the next payout). */
    nextAttempt(invoiceId: string): number {
      const row = getDb().query('SELECT COALESCE(MAX(attempt), 0) + 1 AS next FROM payouts WHERE invoice_id = ? AND tenant_id = ?').get(invoiceId, T) as { next: number } | null
      return row?.next ?? 1
    },
    get(id: string): Payout | null {
      return (getDb().query('SELECT * FROM payouts WHERE id = ? AND tenant_id = ?').get(id, T) as Payout | null) ?? null
    },
    byInvoice(invoiceId: string): Payout[] {
      return getDb()
        .query('SELECT * FROM payouts WHERE invoice_id = ? AND tenant_id = ? ORDER BY created_at DESC')
        .all(invoiceId, T) as Payout[]
    },
    byExecutionId(executionId: string): Payout | null {
      return (
        (getDb()
          .query('SELECT * FROM payouts WHERE thyme_execution_id = ? AND tenant_id = ? LIMIT 1')
          .get(executionId, T) as Payout | null) ?? null
      )
    },
    list(opts: { status?: PayoutStatus; limit?: number } = {}): Payout[] {
      if (opts.status) {
        return getDb()
          .query('SELECT * FROM payouts WHERE tenant_id = ? AND status = ? ORDER BY created_at DESC LIMIT ?')
          .all(T, opts.status, opts.limit ?? 200) as Payout[]
      }
      return getDb()
        .query('SELECT * FROM payouts WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?')
        .all(T, opts.limit ?? 200) as Payout[]
    },
    /**
     * Approved work for the Thyme Flow task: pending payouts whose invoice is approved/paying.
     * payee_wallet is always an APPROVED wallet of the beneficiary: the one the payment agent already selected
     * (to_wallet), else the approved wallet printed on the invoice, else the primary. Never a pending wallet.
     */
    listPendingForThyme(): (Payout & { payee_wallet: string | null; invoice_number: string | null })[] {
      const rows = getDb()
        .query(
          `SELECT p.*, i.number AS invoice_number, i.payee_wallet AS invoice_wallet
           FROM payouts p JOIN invoices i ON i.id = p.invoice_id
           WHERE p.tenant_id = ? AND p.status = 'pending' AND p.executor = 'thyme' AND i.status IN ('approved', 'paying')
           ORDER BY p.created_at ASC`,
        )
        .all(T) as (Payout & { invoice_number: string | null; invoice_wallet: string | null })[]
      return rows.map(({ invoice_wallet, ...p }) => ({
        ...p,
        payee_wallet: p.to_wallet ?? (p.beneficiary_id ? beneficiaryWallets.selectForPayout(p.beneficiary_id, invoice_wallet) : null),
      }))
    },
    /**
     * Pending payouts for the in-process payment agent. Rows handed to Thyme in the last two minutes
     * (submitted_at set while still pending) are left alone so a tick never triggers the same run twice;
     * after that window the trigger is repeated with the same Idempotency-Key (Thyme replays it).
     */
    listPending(): (Payout & { invoice_status: string })[] {
      return getDb()
        .query(
          `SELECT p.*, i.status AS invoice_status FROM payouts p JOIN invoices i ON i.id = p.invoice_id
           WHERE p.tenant_id = ? AND p.status = 'pending' AND i.status IN ('approved', 'paying')
             AND (p.submitted_at IS NULL OR p.submitted_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-120 seconds'))
           ORDER BY p.created_at ASC`,
        )
        .all(T) as (Payout & { invoice_status: string })[]
    },
    /** Confirmed + in-flight EUR for one beneficiary since `sinceIso`, excluding one payout (the 30-day limit check). */
    spentEurSince(beneficiaryId: string, sinceIso: string, excludePayoutId = ''): number {
      const row = getDb()
        .query(
          "SELECT COALESCE(SUM(amount_eur), 0) AS total FROM payouts WHERE beneficiary_id = ? AND tenant_id = ? AND id <> ? AND status IN ('pending', 'submitted', 'confirmed') AND created_at >= ?",
        )
        .get(beneficiaryId, T, excludePayoutId, sinceIso) as { total: number } | null
      return row?.total ?? 0
    },
    /** Confirmed + in-flight EUR per beneficiary in the current calendar month (dashboard budget bars). */
    paidThisMonthByBeneficiary(now = new Date()): Record<string, number> {
      const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString()
      const rows = getDb()
        .query(
          "SELECT beneficiary_id, COALESCE(SUM(amount_eur), 0) AS total FROM payouts WHERE tenant_id = ? AND status IN ('submitted', 'confirmed') AND created_at >= ? AND beneficiary_id IS NOT NULL GROUP BY beneficiary_id",
        )
        .all(T, monthStart) as { beneficiary_id: string; total: number }[]
      return Object.fromEntries(rows.map((r) => [r.beneficiary_id, r.total]))
    },
    update(id: string, patch: Partial<Omit<Payout, 'id' | 'tenant_id' | 'created_at'>>): Payout | null {
      updateRow('payouts', id, patch)
      return payouts.get(id)
    },
    setStatus(id: string, status: PayoutStatus, extra: Partial<Omit<Payout, 'id' | 'tenant_id' | 'created_at' | 'status'>> = {}): Payout | null {
      updateRow('payouts', id, { status, ...extra })
      return payouts.get(id)
    },
  }

  // ---------------------------------------------------------------- agents

  const agents = {
    upsert(input: Omit<Agent, 'tenant_id' | 'last_run_at'> & { last_run_at?: string | null }): Agent {
      getDb()
        .query(
          `INSERT INTO agents (tenant_id, id, name, kind, status, config_json, last_run_at) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(tenant_id, id) DO UPDATE SET name = excluded.name, kind = excluded.kind, status = excluded.status,
             config_json = excluded.config_json, last_run_at = COALESCE(excluded.last_run_at, agents.last_run_at)`,
        )
        .run(T, input.id, input.name, input.kind, input.status, input.config_json ?? null, input.last_run_at ?? null)
      return agents.get(input.id) as Agent
    },
    get(id: string): Agent | null {
      return (getDb().query('SELECT * FROM agents WHERE id = ? AND tenant_id = ?').get(id, T) as Agent | null) ?? null
    },
    list(): Agent[] {
      return getDb().query('SELECT * FROM agents WHERE tenant_id = ? ORDER BY name ASC').all(T) as Agent[]
    },
    setStatus(id: string, status: Agent['status']): Agent | null {
      updateRow('agents', id, { status })
      return agents.get(id)
    },
    touch(id: string, at = nowIso()): void {
      updateRow('agents', id, { last_run_at: at })
    },
    update(id: string, patch: Partial<Omit<Agent, 'id' | 'tenant_id'>>): Agent | null {
      updateRow('agents', id, patch)
      return agents.get(id)
    },
  }

  // ---------------------------------------------------------------- audit log

  function appendAudit(input: AppendAuditInput): AuditEntry {
    mirrorAuditToJsonl(input)
    const res = getDb()
      .query('INSERT INTO audit_log (tenant_id, ts, actor, invoice_id, beneficiary_id, event, details_json) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(T, nowIso(), input.actor, input.invoiceId ?? null, input.beneficiaryId ?? null, input.event, input.details === undefined ? null : JSON.stringify(input.details))
    return getDb()
      .query('SELECT * FROM audit_log WHERE id = ?')
      .get(Number(res.lastInsertRowid)) as AuditEntry
  }

  /** Best-effort mirror into the tenant's sha256 hash-chained JSONL (src/lib/reports/audit.ts). Never throws. */
  function mirrorAuditToJsonl(input: AppendAuditInput): void {
    try {
      const details = input.details && typeof input.details === 'object' ? (input.details as Record<string, unknown>) : input.details === undefined ? {} : { value: input.details }
      appendJsonl({ actor: input.actor, event: input.event, invoice_id: input.invoiceId ?? null, beneficiary_id: input.beneficiaryId ?? null, details }, tenantAuditLogPath(T))
    } catch {
      // the SQLite row is the source of truth; the JSONL is an export
    }
  }

  const audit = {
    append: appendAudit,
    list(opts: { invoiceId?: string; beneficiaryId?: string; limit?: number } = {}): AuditEntry[] {
      const where: string[] = ['tenant_id = ?']
      const args: unknown[] = [T]
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
        .query(`SELECT * FROM audit_log WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`)
        .all(...(args as never[])) as AuditEntry[]
    },
  }

  // ---------------------------------------------------------------- settings

  const settings = {
    get(key: string): string | null {
      const row = getDb().query('SELECT value FROM settings WHERE tenant_id = ? AND key = ?').get(T, key) as Pick<Setting, 'value'> | null
      return row?.value ?? null
    },
    set(key: string, value: string | null): void {
      getDb()
        .query('INSERT INTO settings (tenant_id, key, value) VALUES (?, ?, ?) ON CONFLICT(tenant_id, key) DO UPDATE SET value = excluded.value')
        .run(T, key, value)
    },
    all(): Record<string, string | null> {
      const rows = getDb().query('SELECT key, value FROM settings WHERE tenant_id = ?').all(T) as Pick<Setting, 'key' | 'value'>[]
      return Object.fromEntries(rows.map((r) => [r.key, r.value]))
    },
    remove(key: string): void {
      getDb().query('DELETE FROM settings WHERE tenant_id = ? AND key = ?').run(T, key)
    },
  }

  // ---------------------------------------------------------------- dashboard aggregates

  function dashboardCounts() {
    const db = getDb()
    const one = (sql: string) => (db.query(sql).get(T) as { n: number }).n
    return {
      beneficiaries: one('SELECT COUNT(*) AS n FROM beneficiaries WHERE tenant_id = ?'),
      activeBeneficiaries: one("SELECT COUNT(*) AS n FROM beneficiaries WHERE tenant_id = ? AND status = 'active'"),
      queued: one("SELECT COUNT(*) AS n FROM invoices WHERE tenant_id = ? AND status IN ('queued', 'investigating')"),
      needsApproval: one("SELECT COUNT(*) AS n FROM invoices WHERE tenant_id = ? AND status = 'needs_approval'"),
      onHold: one("SELECT COUNT(*) AS n FROM invoices WHERE tenant_id = ? AND status = 'approved' AND hold = 1"),
      paid: one("SELECT COUNT(*) AS n FROM invoices WHERE tenant_id = ? AND status = 'paid'"),
      paidEur: one("SELECT COALESCE(SUM(amount_eur), 0) AS n FROM payouts WHERE tenant_id = ? AND status = 'confirmed'"),
      agentsRunning: one("SELECT COUNT(*) AS n FROM agents WHERE tenant_id = ? AND status = 'running'"),
      agentsTotal: one('SELECT COUNT(*) AS n FROM agents WHERE tenant_id = ?'),
    }
  }

  return { tenantId: T, beneficiaries, beneficiaryWallets, invoices, payouts, agents, audit, appendAudit, settings, dashboardCounts }
}

export type TenantRepos = ReturnType<typeof buildRepos>

const cache = new Map<string, TenantRepos>()

/** Repos scoped to one tenant. Cheap (memoised per tenant id). */
export function forTenant(tenantId: string): TenantRepos {
  if (!tenantId) throw new Error('forTenant: empty tenant id')
  let repos = cache.get(tenantId)
  if (!repos) {
    repos = buildRepos(tenantId)
    cache.set(tenantId, repos)
  }
  return repos
}

/** Settings shared by the whole process (session secret, founder tenant): tenant '_global'. */
export const globalSettings = forTenant(GLOBAL_TENANT).settings

let founderCache: string | null = null

/** The tenant every pre-multi-tenant row was moved to (migration 005). Also the owner of env THYME_PULL_TOKEN. */
export function founderTenant(): string {
  if (founderCache) return founderCache
  founderCache = (globalSettings.get('founderTenant') ?? FOUNDER_TENANT_FALLBACK).toLowerCase()
  return founderCache
}

/** Hash-chained audit JSONL of one tenant: the founder keeps the original file, every other tenant gets its own. */
export function tenantAuditLogPath(tenantId: string = currentTenant()): string {
  const base = auditLogPath()
  if (tenantId === founderTenant()) return base
  return join(dirname(base), 'audit', `${tenantSlug(tenantId)}.jsonl`)
}

/** Tenants with queued invoices or pending payouts: the worker loop runs each of them in turn. */
export function listTenantsWithWork(): string[] {
  const rows = getDb()
    .query(
      `SELECT DISTINCT tenant_id FROM invoices WHERE status IN ('queued', 'investigating')
       UNION
       SELECT DISTINCT p.tenant_id FROM payouts p JOIN invoices i ON i.id = p.invoice_id
         WHERE p.status = 'pending' AND i.status IN ('approved', 'paying')`,
    )
    .all() as { tenant_id: string }[]
  return rows.map((r) => r.tenant_id).filter((t) => t !== '' && t !== GLOBAL_TENANT)
}

/** The tenant whose stored pull token equals `token` (settings.thymePullToken), or null. */
export function tenantByPullToken(token: string): string | null {
  if (!token) return null
  const row = getDb().query("SELECT tenant_id FROM settings WHERE key = 'thymePullToken' AND value = ? LIMIT 1").get(token) as { tenant_id: string } | null
  return row?.tenant_id ?? null
}

// ---------------------------------------------------------------- context-bound exports

function bound<K extends Exclude<keyof TenantRepos, 'tenantId' | 'appendAudit' | 'dashboardCounts'>>(key: K): TenantRepos[K] {
  return new Proxy({} as TenantRepos[K], {
    get(_target, prop) {
      const value = (forTenant(currentTenant())[key] as unknown as Record<PropertyKey, unknown>)[prop]
      return value
    },
  })
}

/** Bound to the tenant of the current runWithTenant() context; throws outside one. */
export const beneficiaries = bound('beneficiaries')
export const beneficiaryWallets = bound('beneficiaryWallets')
export const invoices = bound('invoices')
export const payouts = bound('payouts')
export const agents = bound('agents')
export const audit = bound('audit')
export const settings = bound('settings')
export function appendAudit(input: AppendAuditInput): AuditEntry {
  return forTenant(currentTenant()).appendAudit(input)
}
export function dashboardCounts() {
  return forTenant(currentTenant()).dashboardCounts()
}

export const listQueue = () => invoices.listQueue()
export const nextQueued = () => invoices.nextQueued()
export const setInvoiceStatus: TenantRepos['invoices']['setStatus'] = (id, status, extra) => invoices.setStatus(id, status, extra)

export { getDb, newId, nowIso } from './sqlite'
export { currentTenant, isAnonymousTenant, runWithTenant, tryCurrentTenant } from './tenant'
