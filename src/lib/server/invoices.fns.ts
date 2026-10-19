// Server functions for the invoice flow. Handlers dynamic-import server-only modules so this file
// can be imported from client components.
import { createServerFn } from '@tanstack/react-start'
import type { ChecklistSnapshot } from '../agent/types'
import type { Beneficiary } from '../store/types'
import type { DemoInvoiceItem, ExtractedView, InvoiceDetail, InvoiceListItem, OverrideCheckItem, RegistrationPlan } from './dto'

const PROVIDER_LABELS: Record<string, string> = {
  bedrock: 'Claude on Amazon Bedrock',
  anthropic: 'Claude via the Anthropic API',
  mock: 'mock provider (no model call)',
}

export const listInvoices = createServerFn({ method: 'GET' }).handler(async (): Promise<InvoiceListItem[]> => {
  const { ensureBooted } = await import('./boot')
  ensureBooted()
  const { invoices, beneficiaries } = await import('../store/repos')
  const names = new Map(beneficiaries.list().map((b) => [b.id, b.name]))
  return invoices.list({ limit: 200 }).map((i) => ({
    id: i.id,
    number: i.number,
    payee_name: i.payee_name,
    beneficiary_name: i.beneficiary_id ? (names.get(i.beneficiary_id) ?? null) : null,
    currency: i.currency,
    amount: i.amount,
    amount_eur: i.amount_eur,
    status: i.status,
    score: i.score,
    created_at: i.created_at,
    updated_at: i.updated_at,
    hold: i.hold === 1,
    override: i.override === 1,
  }))
})

export const getInvoice = createServerFn({ method: 'GET', strict: false })
  .validator((input: { id: string }) => input)
  .handler(async ({ data }): Promise<InvoiceDetail | null> => {
    const { ensureBooted } = await import('./boot')
    ensureBooted()
    const { invoices, payouts, audit, beneficiaries } = await import('../store/repos')
    const { parseChecklist } = await import('../agent/checklist')
    const { describeScore, decisionReason } = await import('../agent/score')
    const { tierOf } = await import('../agent/severity')
    const { serverEnv } = await import('../env')
    const { resolveExecutionMode } = await import('../payments/runner')
    const { readOnboardingState, isOnboarded } = await import('./thymeOnboarding')
    const { readAutoPaySettings } = await import('./autopay')
    const invoice = invoices.get(data.id)
    if (!invoice) return null
    let extracted: ExtractedView | null = null
    if (invoice.extracted_json) {
      try {
        extracted = JSON.parse(invoice.extracted_json) as ExtractedView
      } catch {
        extracted = null
      }
    }
    const provider = serverEnv.llmProvider()
    const state = readOnboardingState()
    const onboarded = isOnboarded(state)
    const checklist = parseChecklist(invoice.checklist_json)
    const beneficiary = invoice.beneficiary_id ? beneficiaries.get(invoice.beneficiary_id) : null
    const autoPaySettings = readAutoPaySettings()
    const autoPay = { threshold: autoPaySettings.threshold, enabled: autoPaySettings.enabled }
    const fails = checklist.entries.filter((e) => e.status === 'fail')
    const reason =
      checklist.finished_at && checklist.score !== null
        ? decisionReason({ score: checklist.score, fails }, beneficiary, autoPay.threshold, { autoPayEnabled: autoPay.enabled })
        : null
    const overrideChecks: OverrideCheckItem[] = checklist.entries.flatMap((e) => {
      const tier = tierOf(e.id)
      if (e.status !== 'fail' && !(e.status === 'warn' && tier === 'critical')) return []
      return [{ id: e.id, label: e.label, status: e.status, tier, evidence: firstSentence(e.evidence) }]
    })
    return {
      invoice,
      checklist,
      extracted,
      beneficiary,
      payouts: payouts.byInvoice(invoice.id),
      audit: audit.list({ invoiceId: invoice.id, limit: 100 }),
      provider: { name: provider, label: PROVIDER_LABELS[provider] ?? provider },
      executionMode: await resolveExecutionMode(serverEnv.paymentExecutor()),
      executor: serverEnv.paymentExecutor(),
      rail: { safeAddress: state.safeAddress, profileId: state.profileId, onboarded, simulated: !onboarded && Boolean(state.simulatedAt) },
      autoPay,
      decisionReason: reason,
      scoreLines: checklist.scoring ? describeScore(checklist.scoring) : [],
      overrideChecks,
    }
  })

/** First sentence of a check's evidence (max ~140 chars) for the acknowledgement line of the override modal. */
function firstSentence(text: string): string {
  const trimmed = text.trim()
  const end = trimmed.search(/[.;]\s/)
  const sentence = end > 0 ? trimmed.slice(0, end + 1) : trimmed
  return sentence.length > 140 ? `${sentence.slice(0, 137)}…` : sentence
}

const DEMO_HINTS: Record<string, string> = {
  'INV-0388': 'Studio Nord · company · GBP · SEPA (NO)',
  'INV-0401': 'Marko Petrović · RS · EUR',
  'INV-0412': 'Anna Kovalenko · UA · EUR · first invoice',
  'INV-0418': 'Nino Beridze · GE · USD',
  'INV-0423': 'Priya Sharma · IN · INR',
  'INV-0431': 'Anna Kovalenko · second invoice · auto-pay',
  'INV-0432': 'FRAUD · Anna’s name, attacker wallet',
  'INV-0440': 'INJECTION · hidden instructions in the PDF',
}

export const listDemoInvoices = createServerFn({ method: 'GET' }).handler(async (): Promise<DemoInvoiceItem[]> => {
  const { readdirSync, statSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { demoInvoicesDir } = await import('./demo')
  const { invoices } = await import('../store/repos')
  const dir = demoInvoicesDir()
  let files: string[] = []
  try {
    files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.pdf')).sort()
  } catch {
    files = []
  }
  const queued = new Set(invoices.list({ limit: 500 }).filter((i) => i.status === 'queued' || i.status === 'investigating').map((i) => i.file_path?.split('/').pop() ?? ''))
  return files.map((file) => {
    const number = file.slice(0, 8)
    return { file, number, hint: DEMO_HINTS[number] ?? file, size: statSync(join(dir, file)).size, alreadyQueued: queued.has(file) }
  })
})

export const enqueueDemoInvoice = createServerFn({ method: 'POST' })
  .validator((input: { file: string }) => input)
  .handler(async ({ data }): Promise<{ id: string }> => {
    const { enqueueDemoFile } = await import('./demo')
    return { id: await enqueueDemoFile(data.file) }
  })

/**
 * "Re-run checks": investigate the invoice again from the stored PDF. The beneficiary link stays (the registry
 * match is deterministic: tax id, wallet on file, then name). Refused while a payout is in flight or once paid,
 * so a re-run can never pay twice. Idempotent: an invoice already queued is left queued.
 */
export const retryInvoice = createServerFn({ method: 'POST' })
  .validator((input: { id: string }) => input)
  .handler(async ({ data }): Promise<{ ok: true; status: string }> => {
    const { invoices, payouts, appendAudit } = await import('../store/repos')
    const { isPayoutStuck } = await import('../payments/runner')
    const { onInvoiceQueued } = await import('../integration')
    const invoice = invoices.get(data.id)
    if (!invoice) throw new Error('invoice not found')
    if (invoice.status === 'queued') return { ok: true, status: invoice.status }
    const rows = payouts.byInvoice(invoice.id)
    if (invoice.status === 'paid' || rows.some((p) => p.status === 'confirmed')) throw new Error('This invoice is already paid; re-running the checks would pay it twice')
    const inFlight = rows.find((p) => (p.status === 'pending' || p.status === 'submitted') && !isPayoutStuck(p))
    if (inFlight) throw new Error(`A payout is ${inFlight.status} for this invoice; check its status or discard it first`)
    if (!invoice.file_path) throw new Error('The invoice PDF is not stored; upload it again')
    invoices.update(invoice.id, { status: 'queued', checklist_json: null, score: null, decision_text: null, hold: 0, override: 0 })
    appendAudit({ actor: 'owner', event: 'invoice.retried', invoiceId: invoice.id, beneficiaryId: invoice.beneficiary_id, details: { previous_status: invoice.status, keeps_beneficiary: Boolean(invoice.beneficiary_id), was_on_hold: invoice.hold === 1, was_overridden: invoice.override === 1 } })
    void onInvoiceQueued(invoice.id)
    return { ok: true, status: 'queued' }
  })

/**
 * "Mark as failed / discard": settle every pending or submitted payout of the invoice as failed and put the invoice
 * itself in `failed`, so a stuck item stops blocking the queue. Idempotent; a paid invoice is left untouched.
 */
export const discardInvoice = createServerFn({ method: 'POST' })
  .validator((input: { id: string }) => input)
  .handler(async ({ data }): Promise<{ ok: true; status: string; discardedPayouts: number }> => {
    const { invoices, payouts, appendAudit } = await import('../store/repos')
    const { discardPayout } = await import('../payments/runner')
    const invoice = invoices.get(data.id)
    if (!invoice) throw new Error('invoice not found')
    if (invoice.status === 'paid') return { ok: true, status: invoice.status, discardedPayouts: 0 }
    let discarded = 0
    for (const p of payouts.byInvoice(invoice.id)) {
      if (p.status !== 'pending' && p.status !== 'submitted') continue
      await discardPayout(p.id, 'Discarded by the owner (stuck)')
      discarded += 1
    }
    if (invoice.status !== 'failed') {
      invoices.setStatus(invoice.id, 'failed', { decision_text: `${invoice.decision_text ?? ''}\n\nMarked as failed by the owner while ${invoice.status}.`.trim() })
      appendAudit({ actor: 'owner', event: 'invoice.discarded', invoiceId: invoice.id, beneficiaryId: invoice.beneficiary_id, details: { previous_status: invoice.status, discarded_payouts: discarded } })
    }
    return { ok: true, status: 'failed', discardedPayouts: discarded }
  })

/**
 * Retry icon in the queue list: a failed invoice whose last payout failed or reverted gets "Retry payout" (new
 * Idempotency-Key); every other failed / stopped invoice gets its checks re-run. Idempotent like both callees.
 */
export const quickRetryInvoice = createServerFn({ method: 'POST' })
  .validator((input: { id: string }) => input)
  .handler(async ({ data }): Promise<{ action: 'retry_payout' | 'rerun_checks'; message: string }> => {
    const { invoices, payouts } = await import('../store/repos')
    const invoice = invoices.get(data.id)
    if (!invoice) throw new Error('invoice not found')
    const last = payouts.byInvoice(invoice.id)[0] ?? null
    if (invoice.status === 'failed' && last && (last.status === 'failed' || last.status === 'reverted')) {
      const { retryPayout } = await import('../payments/runner')
      const result = await retryPayout(last.id)
      return { action: 'retry_payout', message: result.message }
    }
    const result = await retryInvoice({ data: { id: invoice.id } })
    return { action: 'rerun_checks', message: result.status === 'queued' ? 'Checks queued again' : `Invoice is ${result.status}` }
  })

export const runWorkerOnce = createServerFn({ method: 'POST' }).handler(async () => {
  const { runOnce } = await import('./boot')
  return runOnce()
})

export const forceInvoicePayout = createServerFn({ method: 'POST' })
  .validator((input: { id: string }) => input)
  .handler(async ({ data }) => {
    const { forcePayout } = await import('../payments/runner')
    const payout = await forcePayout(data.id)
    return { payoutId: payout.id, status: payout.status, txHash: payout.tx_hash, error: payout.error, simulated: payout.simulated === 1 }
  })

export interface ApproveBeneficiaryInput {
  invoiceId: string
  name: string
  wallet: string
  type: 'person' | 'company'
  country: string
  taxId: string | null
  email: string | null
  website: string | null
  monthlyLimitEur: number
}

export interface ApproveBeneficiaryResult {
  beneficiary: Beneficiary
  plan: RegistrationPlan
}

/** Creates (or updates) the beneficiary for a held invoice and describes what registering it means (no Safe tx). */
export const approveBeneficiary = createServerFn({ method: 'POST' })
  .validator((input: ApproveBeneficiaryInput) => input)
  .handler(async ({ data }): Promise<ApproveBeneficiaryResult> => {
    const { isAddress, getAddress } = await import('viem')
    const { invoices, beneficiaries, appendAudit } = await import('../store/repos')
    const { planRegistration } = await import('./registration')
    const { demoOwnershipProofFor } = await import('./demo')
    if (!isAddress(data.wallet)) throw new Error('wallet is not a valid address')
    if (!(data.monthlyLimitEur > 0)) throw new Error('monthly limit must be positive')
    const invoice = invoices.get(data.invoiceId)
    if (!invoice) throw new Error('invoice not found')
    const wallet = getAddress(data.wallet)
    const existing = (invoice.beneficiary_id ? beneficiaries.get(invoice.beneficiary_id) : null) ?? beneficiaries.byWallet(wallet) ?? beneficiaries.byName(data.name)
    const patch = {
      name: data.name.trim(),
      type: data.type,
      country: data.country.trim().toUpperCase() || null,
      tax_id: data.taxId?.trim() || null,
      wallet,
      email: data.email?.trim() || null,
      website: data.website?.trim() || null,
      monthly_limit_eur: data.monthlyLimitEur,
      ownership_proof_json: existing?.ownership_proof_json ?? demoOwnershipProofFor(wallet),
    }
    const beneficiary = existing ? (beneficiaries.update(existing.id, patch) as Beneficiary) : beneficiaries.create({ ...patch, status: 'new', trust_score: 60 })
    invoices.update(invoice.id, { beneficiary_id: beneficiary.id })
    appendAudit({
      actor: 'owner',
      event: existing ? 'beneficiary.updated' : 'beneficiary.registered',
      invoiceId: invoice.id,
      beneficiaryId: beneficiary.id,
      details: { name: beneficiary.name, wallet, monthly_limit_eur: data.monthlyLimitEur, country: beneficiary.country },
    })
    const plan = await planRegistration(beneficiary, data.monthlyLimitEur)
    return { beneficiary, plan }
  })

/** 'send' (default) approves and enqueues the payout; 'hold' approves without releasing it ("Send" later). */
export type ApprovalMode = 'send' | 'hold'

export interface RegisterBeneficiaryInput {
  invoiceId: string
  beneficiaryId: string
  mode?: ApprovalMode
}

export interface ApprovalResult {
  payoutId: string | null
  invoiceStatus: string
  /** True when the invoice is approved but the payout waits for "Send". */
  hold: boolean
}

/**
 * Owner confirmed the registration: activate the payee with its agent-enforced limit and approve the invoice.
 * mode 'send': the payment agent then hands the payout to Thyme (or records a labelled simulated payout).
 * mode 'hold': the invoice is approved and kept on hold; nothing is enqueued until the owner clicks "Send".
 * No Safe transaction: the rail was scoped once, at onboarding.
 */
export const registerBeneficiary = createServerFn({ method: 'POST' })
  .validator((input: RegisterBeneficiaryInput) => input)
  .handler(async ({ data }): Promise<ApprovalResult> => {
    const { invoices, beneficiaries, appendAudit, agents } = await import('../store/repos')
    const { approveInvoice } = await import('../agent/service')
    const { runPaymentsOnce } = await import('../payments/runner')
    const { readOnboardingState, isReadyToPay } = await import('./thymeOnboarding')
    const mode: ApprovalMode = data.mode ?? 'send'
    const invoice = invoices.get(data.invoiceId)
    if (!invoice) throw new Error('invoice not found')
    const beneficiary = beneficiaries.get(data.beneficiaryId)
    if (!beneficiary) throw new Error('beneficiary not found')
    const state = readOnboardingState()
    const ready = isReadyToPay(state)

    beneficiaries.update(beneficiary.id, { status: 'active', trust_score: Math.max(beneficiary.trust_score, 70) })
    appendAudit({
      actor: 'owner',
      event: 'beneficiary.activated',
      invoiceId: invoice.id,
      beneficiaryId: beneficiary.id,
      details: { wallet: beneficiary.wallet, monthly_limit_eur: beneficiary.monthly_limit_eur, enforcement: 'agent', rail: ready ? (state.simulatedAt && !state.webhookUrl ? 'simulated' : 'thyme') : 'not onboarded' },
    })

    let payoutId: string | null = null
    let hold = invoice.status === 'approved' && invoice.hold === 1
    const approvable = invoice.status === 'needs_approval' || invoice.status === 'rejected' || invoice.status === 'failed' || hold
    if (approvable) {
      const fails = failedEntries(invoice.checklist_json)
      if (fails.length > 0 && invoice.override !== 1) {
        throw new Error(`Cannot approve: ${fails.map((f) => f.label).join(', ')} failed`)
      }
      if (mode === 'hold') {
        invoices.update(invoice.id, { status: 'approved', hold: 1 })
        appendAudit({
          actor: 'owner',
          event: 'invoice.approved_hold',
          invoiceId: invoice.id,
          beneficiaryId: beneficiary.id,
          details: { previous_status: invoice.status, amount_eur: invoice.amount_eur ?? invoice.amount, monthly_limit_eur: beneficiary.monthly_limit_eur, note: 'approved, payout not released' },
        })
        hold = true
      } else {
        invoices.update(invoice.id, { hold: 0 })
        const payout = approveInvoice(invoice.id)
        payoutId = payout.id
        hold = false
        agents.touch('compliance')
        void runPaymentsOnce()
      }
    }
    const after = invoices.get(invoice.id)
    return { payoutId, invoiceStatus: after?.status ?? invoice.status, hold }
  })

/**
 * "Send": release an approved invoice that the owner kept on hold. Enqueues the payout the normal way (recipient =
 * wallet on file, payment agent -> Thyme). Idempotent: an in-flight payout is reported instead of created twice.
 */
export const sendHeldInvoice = createServerFn({ method: 'POST' })
  .validator((input: { id: string }) => input)
  .handler(async ({ data }): Promise<ApprovalResult> => {
    const { invoices, beneficiaries, payouts, appendAudit, agents } = await import('../store/repos')
    const { approveInvoice } = await import('../agent/service')
    const { runPaymentsOnce } = await import('../payments/runner')
    const invoice = invoices.get(data.id)
    if (!invoice) throw new Error('invoice not found')
    const inFlight = payouts.byInvoice(invoice.id).find((p) => p.status === 'pending' || p.status === 'submitted')
    if (inFlight) return { payoutId: inFlight.id, invoiceStatus: invoice.status, hold: false }
    if (invoice.status === 'paid') throw new Error('This invoice is already paid')
    if (!(invoice.status === 'approved' && invoice.hold === 1)) throw new Error(`Invoice is ${invoice.status}; only an approved invoice on hold can be sent`)
    if (!invoice.beneficiary_id) throw new Error('No beneficiary on file; register the payee first')
    const beneficiary = beneficiaries.get(invoice.beneficiary_id)
    if (!beneficiary || beneficiary.status !== 'active') throw new Error(`${beneficiary?.name ?? 'The beneficiary'} is not active`)
    const fails = failedEntries(invoice.checklist_json)
    if (fails.length > 0 && invoice.override !== 1) throw new Error(`Cannot send: ${fails.map((f) => f.label).join(', ')} failed`)
    invoices.update(invoice.id, { hold: 0 })
    appendAudit({ actor: 'owner', event: 'invoice.released', invoiceId: invoice.id, beneficiaryId: beneficiary.id, details: { amount_eur: invoice.amount_eur ?? invoice.amount, to: beneficiary.wallet } })
    const payout = approveInvoice(invoice.id)
    agents.touch('compliance')
    void runPaymentsOnce()
    return { payoutId: payout.id, invoiceStatus: 'approved', hold: false }
  })

export interface OverrideRegistration {
  name: string
  wallet: string
  monthlyLimitEur: number
}

export interface OverridePayoutInput {
  invoiceId: string
  /** Ids of the failed / critical-warn checks the owner ticked in the modal. */
  acknowledgedCheckIds: string[]
  reason: string
  /** Only when the invoice has no beneficiary on file: the payee the owner vouches for. */
  registration?: OverrideRegistration | null
}

export interface OverridePayoutResult extends ApprovalResult {
  /** Wallet the payout goes to (always the wallet on file, never the one printed on the PDF). */
  to: string | null
  acknowledged: string[]
}

/**
 * "Send anyway" on a rejected invoice: the owner acknowledges every failed (and critical-warn) check by id, gives a
 * reason, and the payout is enqueued the normal way (recipient = wallet on file, through the payment agent and Thyme).
 * Audit: owner.override with the reason and the check ids. The invoice and its payout carry override = 1.
 */
export const overridePayout = createServerFn({ method: 'POST' })
  .validator((input: OverridePayoutInput) => input)
  .handler(async ({ data }): Promise<OverridePayoutResult> => {
    const { isAddress, getAddress } = await import('viem')
    const { invoices, beneficiaries, payouts, appendAudit, agents } = await import('../store/repos')
    const { approveInvoice } = await import('../agent/service')
    const { runPaymentsOnce } = await import('../payments/runner')
    const { tierOf } = await import('../agent/severity')
    const { demoOwnershipProofFor } = await import('./demo')
    const invoice = invoices.get(data.invoiceId)
    if (!invoice) throw new Error('invoice not found')
    if (invoice.status === 'paid') throw new Error('This invoice is already paid')
    const inFlight = payouts.byInvoice(invoice.id).find((p) => p.status === 'pending' || p.status === 'submitted')
    if (inFlight) return { payoutId: inFlight.id, invoiceStatus: invoice.status, hold: false, to: null, acknowledged: data.acknowledgedCheckIds }
    const snapshot = parseSnapshot(invoice.checklist_json)
    if (!snapshot || !snapshot.finished_at) throw new Error('The checks have not finished; nothing to override')
    const required = snapshot.entries.filter((e) => e.status === 'fail' || (e.status === 'warn' && tierOf(e.id) === 'critical'))
    const acknowledged = new Set(data.acknowledgedCheckIds)
    const missing = required.filter((e) => !acknowledged.has(e.id))
    if (missing.length > 0) throw new Error(`Acknowledge every failed check first: ${missing.map((m) => m.label).join(', ')}`)
    const reason = data.reason.trim()
    if (reason.length < 3) throw new Error('A reason is required')

    let beneficiary = invoice.beneficiary_id ? beneficiaries.get(invoice.beneficiary_id) : null
    if (!beneficiary) {
      const reg = data.registration
      if (!reg) throw new Error('No payee on file: fill in the beneficiary to register')
      if (!isAddress(reg.wallet)) throw new Error('wallet is not a valid address')
      if (!(reg.monthlyLimitEur > 0)) throw new Error('monthly limit must be positive')
      const wallet = getAddress(reg.wallet)
      const proposal = snapshot.proposal
      beneficiary = beneficiaries.create({
        name: reg.name.trim() || proposal?.name || invoice.payee_name || 'Unknown payee',
        type: proposal?.type ?? 'person',
        country: proposal?.country ?? null,
        tax_id: proposal?.tax_id ?? null,
        wallet,
        email: proposal?.email ?? null,
        website: proposal?.website ?? null,
        monthly_limit_eur: reg.monthlyLimitEur,
        status: 'active',
        trust_score: 50,
        ownership_proof_json: demoOwnershipProofFor(wallet),
      })
      invoices.update(invoice.id, { beneficiary_id: beneficiary.id })
      appendAudit({ actor: 'owner', event: 'beneficiary.registered', invoiceId: invoice.id, beneficiaryId: beneficiary.id, details: { name: beneficiary.name, wallet, monthly_limit_eur: reg.monthlyLimitEur, override: true } })
    } else if (beneficiary.status !== 'active') {
      beneficiary = beneficiaries.update(beneficiary.id, { status: 'active' }) as Beneficiary
      appendAudit({ actor: 'owner', event: 'beneficiary.activated', invoiceId: invoice.id, beneficiaryId: beneficiary.id, details: { wallet: beneficiary.wallet, monthly_limit_eur: beneficiary.monthly_limit_eur, enforcement: 'agent', override: true } })
    }
    if (!beneficiary.wallet) throw new Error(`${beneficiary.name} has no wallet on file`)

    appendAudit({
      actor: 'owner',
      event: 'owner.override',
      invoiceId: invoice.id,
      beneficiaryId: beneficiary.id,
      details: {
        reason,
        check_ids: required.map((e) => e.id),
        acknowledged_check_ids: [...acknowledged],
        checks: required.map((e) => ({ id: e.id, label: e.label, status: e.status })),
        previous_status: invoice.status,
        amount_eur: invoice.amount_eur ?? invoice.amount,
        to: beneficiary.wallet,
        pdf_wallet: invoice.payee_wallet,
        note: 'owner paid despite failed checks; recipient is the wallet on file, never the PDF',
      },
    })
    invoices.update(invoice.id, { status: 'approved', override: 1, hold: 0 })
    const payout = approveInvoice(invoice.id)
    payouts.update(payout.id, { override: 1 })
    agents.touch('compliance')
    void runPaymentsOnce()
    return { payoutId: payout.id, invoiceStatus: 'approved', hold: false, to: beneficiary.wallet, acknowledged: [...acknowledged] }
  })

function parseSnapshot(json: string | null): ChecklistSnapshot | null {
  if (!json) return null
  try {
    return JSON.parse(json) as ChecklistSnapshot
  } catch {
    return null
  }
}

function failedEntries(json: string | null): ChecklistSnapshot['entries'] {
  return parseSnapshot(json)?.entries.filter((e) => e.status === 'fail') ?? []
}
