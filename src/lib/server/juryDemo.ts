// Server-only: the "Jury demo" tenant. An anonymous demo tenant is seeded once with the five demo beneficiaries,
// three historical (labelled simulated) payouts and two open invoices: INV-0388 waiting for approval and INV-0432,
// the forged-wallet invoice, stopped. The extraction and checklist of every seeded invoice come from
// demo/fixtures/<number>.json, recorded once with the mock provider: seeding never calls a model. Everything the
// judges do afterwards (upload, approve, send anyway) runs the real pipeline. settings.demoMode = '1' marks the
// tenant so the guided tour shows; real tenants never see it.
import { copyFileSync, existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseUnits } from 'viem'
import demoPayees from '../../../demo/payees.json'
import type { ChecklistSnapshot } from '../agent/types'
import { SIMULATED_GAS_USED, simulatedTxHash } from '../payments/runner'
import { appendAudit, beneficiaries, beneficiaryWallets, currentTenant, getDb, invoices, newId, nowIso, payouts, settings } from '../store/repos'
import { invoicesDir } from '../store/sqlite'
import type { Beneficiary, InvoiceStatus } from '../store/types'
import { demoInvoicesDir, enqueueDemoFile } from './demo'
import { readOnboardingState, simulateOnboarding } from './thymeOnboarding'

if (typeof window !== 'undefined') {
  throw new Error('src/lib/server/juryDemo.ts is server-only')
}

export const DEMO_MODE_KEY = 'demoMode'
const DEMO_SEEDED_KEY = 'demoSeededAt'

interface DemoPayee {
  id: string
  name: string
  type: 'person' | 'company'
  country: string
  tax_id: string
  wallet: string
  email: string | null
  lei: string | null
  website: string | null
  monthly_limit_eur?: number
  ownership_proof?: Record<string, unknown> | null
  extra_wallets?: { wallet: string; label?: string }[]
}

interface DemoInvoiceEntry {
  file: string
  number: string
  payee_id: string
}

/** One recorded investigation (scripts/dump-demo-fixtures.ts): what the pipeline wrote on the invoice row. */
export interface DemoFixture {
  number: string
  file: string
  payee_id: string
  status: InvoiceStatus
  score: number | null
  decision_text: string | null
  invoice: {
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
  }
  extracted: unknown
  checklist: ChecklistSnapshot
}

const data = demoPayees as unknown as { payees: DemoPayee[]; invoices: DemoInvoiceEntry[] }

/** Trust the owner built up with each contractor; Nino has no EIP-712 proof on file. */
const TRUST: Record<string, number> = { 'anna-kovalenko': 92, 'marko-petrovic': 88, 'priya-sharma': 85, 'studio-nord-ltd': 81, 'nino-beridze': 72 }

interface SeedInvoice {
  number: string
  payee: string
  status: 'paid' | 'needs_approval' | 'rejected'
  /** How long ago the invoice landed. */
  hoursAgo: number
}

/** Oldest first: last_paid_at and the activity feed read naturally. */
const SEED_INVOICES: SeedInvoice[] = [
  { number: 'INV-0401', payee: 'marko-petrovic', status: 'paid', hoursAgo: 13 * 24 + 5 },
  { number: 'INV-0412', payee: 'anna-kovalenko', status: 'paid', hoursAgo: 9 * 24 + 2 },
  { number: 'INV-0423', payee: 'priya-sharma', status: 'paid', hoursAgo: 4 * 24 + 7 },
  { number: 'INV-0388', payee: 'studio-nord-ltd', status: 'needs_approval', hoursAgo: 3 },
  { number: 'INV-0432', payee: 'anna-kovalenko', status: 'rejected', hoursAgo: 1 },
]

export const JURY_DEMO_INVOICE_NUMBERS = SEED_INVOICES.map((s) => s.number)

const round2 = (n: number): number => Math.round(n * 100) / 100
const agoIso = (hours: number, plusSeconds = 0): string => new Date(Date.now() - hours * 3_600_000 + plusSeconds * 1000).toISOString()

function fixturesDir(): string {
  const candidates = [resolve(process.cwd(), 'demo/fixtures'), resolve(process.cwd(), '../demo/fixtures')]
  return candidates.find((c) => existsSync(c)) ?? candidates[0]
}

export function loadFixture(number: string): DemoFixture | null {
  const path = join(fixturesDir(), `${number}.json`)
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as DemoFixture
  } catch {
    return null
  }
}

function demoFileFor(number: string): string | null {
  const entry = data.invoices.find((i) => i.number === number)
  return entry ? (entry.file.split('/').pop() ?? null) : null
}

function backdate(table: 'beneficiaries' | 'invoices' | 'payouts', id: string, patch: Record<string, string>): void {
  const cols = Object.keys(patch)
  if (cols.length === 0) return
  getDb()
    .query(`UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ? AND tenant_id = ?`)
    .run(...(Object.values(patch) as never[]), id, currentTenant())
}

function auditAt(ts: string, input: Parameters<typeof appendAudit>[0]): void {
  const row = appendAudit(input)
  getDb().query('UPDATE audit_log SET ts = ? WHERE id = ?').run(ts, row.id)
}

export function isJuryDemoTenant(): boolean {
  return settings.get(DEMO_MODE_KEY) === '1'
}

function seedBeneficiaries(): Map<string, Beneficiary> {
  const out = new Map<string, Beneficiary>()
  // Anna last: she is the first row of the Beneficiaries table (newest first) and the one the tour opens.
  const order = ['nino-beridze', 'studio-nord-ltd', 'priya-sharma', 'marko-petrovic', 'anna-kovalenko']
  const payees = [...data.payees].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id))
  payees.forEach((p, index) => {
    const existing = beneficiaries.byWallet(p.wallet) ?? beneficiaries.byName(p.name)
    const createdAt = agoIso((45 - index * 3) * 24)
    const row =
      existing ??
      beneficiaries.create({
        name: p.name,
        type: p.type,
        country: p.country,
        tax_id: p.tax_id,
        wallet: p.wallet,
        email: p.email,
        lei: p.lei,
        website: p.website,
        monthly_limit_eur: p.monthly_limit_eur ?? 500,
        status: 'active',
        trust_score: TRUST[p.id] ?? 80,
        ownership_proof_json: p.ownership_proof ? JSON.stringify(p.ownership_proof) : null,
      })
    if (!existing) {
      backdate('beneficiaries', row.id, { created_at: createdAt })
      getDb().query('UPDATE beneficiary_wallets SET created_at = ?, approved_at = ? WHERE beneficiary_id = ?').run(createdAt, createdAt, row.id)
      auditAt(createdAt, { actor: 'owner', event: 'beneficiary.activated', beneficiaryId: row.id, details: { wallet: row.wallet, monthly_limit_eur: row.monthly_limit_eur, enforcement: 'agent', rail: 'simulated', demo: true } })
      for (const extra of p.extra_wallets ?? []) {
        beneficiaryWallets.ensureApproved({ beneficiaryId: row.id, wallet: extra.wallet, label: 'hardware wallet', source: 'manual', approvedBy: 'owner' })
      }
    }
    out.set(p.id, beneficiaries.get(row.id) ?? row)
  })
  return out
}

function cnbOf(checklist: ChecklistSnapshot): { czkPerUnit: number; validFor: string } | null {
  const fx = checklist.entries.find((e) => e.id === 'fx_rate')?.data as { cnb?: { czkPerUnit?: number; validFor?: string } | null } | undefined
  const cnb = fx?.cnb
  return cnb && typeof cnb.czkPerUnit === 'number' && typeof cnb.validFor === 'string' ? { czkPerUnit: cnb.czkPerUnit, validFor: cnb.validFor } : null
}

function seedInvoice(seed: SeedInvoice, fixture: DemoFixture, beneficiary: Beneficiary): string {
  const id = newId()
  const src = join(demoInvoicesDir(), fixture.file)
  let filePath: string | null = null
  if (existsSync(src)) {
    filePath = join(invoicesDir(), `${id}.pdf`)
    copyFileSync(src, filePath)
  }
  const uploadedAt = agoIso(seed.hoursAgo)
  const decidedAt = agoIso(seed.hoursAgo, 14)
  const checklist = fixture.checklist
  const decision = seed.status === 'paid' ? 'approved' : seed.status
  invoices.create({
    id,
    beneficiary_id: beneficiary.id,
    file_path: filePath,
    number: fixture.number,
    issue_date: fixture.invoice.issue_date,
    due_date: fixture.invoice.due_date,
    currency: fixture.invoice.currency,
    amount: fixture.invoice.amount,
    amount_eur: fixture.invoice.amount_eur,
    fx_rate: fixture.invoice.fx_rate,
    fx_source: fixture.invoice.fx_source,
    fx_at: fixture.invoice.fx_at,
    payee_name: fixture.invoice.payee_name,
    payee_wallet: fixture.invoice.payee_wallet,
    extracted_json: JSON.stringify(fixture.extracted),
    status: seed.status,
    score: fixture.score,
    checklist_json: JSON.stringify(checklist),
    decision_text: fixture.decision_text,
  })
  backdate('invoices', id, { created_at: uploadedAt, updated_at: decidedAt })
  auditAt(uploadedAt, { actor: 'owner', event: 'invoice.uploaded', invoiceId: id, details: { name: fixture.file, demo: true, jury: true } })
  auditAt(agoIso(seed.hoursAgo, 1), { actor: 'agent', event: 'investigation.started', invoiceId: id, details: { provider: checklist.llm.provider, replayed_from_fixture: true } })
  const fails = checklist.entries.filter((e) => e.status === 'fail').map((e) => e.id)
  const warns = checklist.entries.filter((e) => e.status === 'warn').map((e) => e.id)
  auditAt(decidedAt, { actor: 'agent', event: `invoice.${decision}`, invoiceId: id, beneficiaryId: beneficiary.id, details: { score: fixture.score, fails, warns, llm_cost_usd: checklist.llm.cost_usd, replayed_from_fixture: true } })

  if (seed.status === 'rejected' && fixture.invoice.payee_wallet && beneficiary.wallet && fixture.invoice.payee_wallet.toLowerCase() !== beneficiary.wallet.toLowerCase()) {
    // The wallet printed on the forged invoice waits for the owner on the Beneficiaries page, as the pipeline would record it.
    beneficiaryWallets.propose({ beneficiaryId: beneficiary.id, wallet: fixture.invoice.payee_wallet, label: `printed on ${fixture.number}`, source: 'invoice' })
  }

  if (seed.status === 'paid') {
    const amountEur = round2(fixture.invoice.amount_eur ?? fixture.invoice.amount ?? 0)
    const cnb = cnbOf(checklist)
    const enqueuedAt = agoIso(seed.hoursAgo, 15)
    const confirmedAt = agoIso(seed.hoursAgo, 34)
    const payout = payouts.create({
      invoice_id: id,
      beneficiary_id: beneficiary.id,
      amount_eurc: parseUnits(amountEur.toFixed(6), 6).toString(),
      amount_eur: amountEur,
      currency: fixture.invoice.currency ?? 'EUR',
      fx_rate: fixture.invoice.fx_rate ?? 1,
      cnb_rate: cnb?.czkPerUnit ?? null,
      cnb_valid_for: cnb?.validFor ?? null,
      amount_czk: cnb ? round2(amountEur * cnb.czkPerUnit) : null,
      executor: 'thyme',
      tx_hash: simulatedTxHash(`jury:${currentTenant()}:${fixture.number}`),
      status: 'confirmed',
      submitted_at: agoIso(seed.hoursAgo, 18),
      confirmed_at: confirmedAt,
      gas_used: SIMULATED_GAS_USED,
      simulated: 1,
      attempt: 1,
      to_wallet: beneficiary.wallet,
    })
    backdate('payouts', payout.id, { created_at: enqueuedAt })
    beneficiaries.recordPaid(beneficiary.id, amountEur, confirmedAt)
    auditAt(enqueuedAt, { actor: 'agent', event: 'payout.enqueued', invoiceId: id, beneficiaryId: beneficiary.id, details: { payout_id: payout.id, amount_eurc: payout.amount_eurc, amount_eur: amountEur, to: beneficiary.wallet, executor: 'thyme' } })
    auditAt(confirmedAt, {
      actor: 'agent',
      event: 'payout.confirmed',
      invoiceId: id,
      beneficiaryId: beneficiary.id,
      details: { payout_id: payout.id, amount_eur: amountEur, amount_eurc: payout.amount_eurc, tx_hash: payout.tx_hash, block_number: null, gas_used: SIMULATED_GAS_USED, error: null, simulated: true, executor: 'thyme', thyme_execution_id: null },
    })
  }
  return id
}

export interface SeedResult {
  seeded: boolean
  /** Numbers seeded from a fixture. */
  fromFixtures: string[]
  /** Numbers that had no fixture and were queued through the live pipeline instead (local fixture recording only). */
  queued: string[]
}

/**
 * Idempotent per tenant: the first call seeds, later calls only make sure demoMode is on. Fixtures missing on disk
 * fall back to the real pipeline (mock or model, whatever the server runs); that path exists to record the fixtures.
 */
export async function seedJuryDemo(): Promise<SeedResult> {
  settings.set(DEMO_MODE_KEY, '1')
  if (settings.get(DEMO_SEEDED_KEY)) return { seeded: false, fromFixtures: [], queued: [] }
  const onboarding = readOnboardingState()
  if (!onboarding.simulatedAt && !onboarding.profileId) simulateOnboarding(null)
  const bens = seedBeneficiaries()
  const fromFixtures: string[] = []
  const queued: string[] = []
  for (const seed of SEED_INVOICES) {
    const beneficiary = bens.get(seed.payee)
    if (!beneficiary) continue
    const fixture = loadFixture(seed.number)
    if (fixture) {
      seedInvoice(seed, fixture, beneficiary)
      fromFixtures.push(seed.number)
      continue
    }
    const file = demoFileFor(seed.number)
    if (!file) continue
    await enqueueDemoFile(file)
    queued.push(seed.number)
  }
  settings.set(DEMO_SEEDED_KEY, nowIso())
  appendAudit({ actor: 'owner', event: 'demo.jury_seeded', details: { from_fixtures: fromFixtures, queued } })
  return { seeded: true, fromFixtures, queued }
}

/** What the tour needs to navigate: whether this tenant is a demo, and the ids of the seeded anchors. */
export interface JuryDemoState {
  mode: boolean
  /** Invoice id by number (INV-0388, INV-0432, ...), newest row per number. */
  invoices: Record<string, string>
  /** A confirmed payout to open the remittance advice for. */
  payoutId: string | null
}

export const EMPTY_DEMO_STATE: JuryDemoState = { mode: false, invoices: {}, payoutId: null }

export function readJuryDemoState(): JuryDemoState {
  if (!isJuryDemoTenant()) return EMPTY_DEMO_STATE
  const wanted = new Set(JURY_DEMO_INVOICE_NUMBERS)
  const byNumber: Record<string, string> = {}
  for (const row of invoices.list({ limit: 300 })) {
    if (row.number && wanted.has(row.number) && !byNumber[row.number]) byNumber[row.number] = row.id
  }
  const confirmed = payouts.list({ limit: 50 }).find((p) => p.status === 'confirmed') ?? null
  return { mode: true, invoices: byNumber, payoutId: confirmed?.id ?? null }
}
