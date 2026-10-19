// Server functions for the invoice flow. Handlers dynamic-import server-only modules so this file
// can be imported from client components.
import { createServerFn } from '@tanstack/react-start'
import type { ChecklistSnapshot } from '../agent/types'
import type { Beneficiary } from '../store/types'
import type { DemoInvoiceItem, ExtractedView, InvoiceDetail, InvoiceListItem, MandatePlan } from './dto'

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
  }))
})

export const getInvoice = createServerFn({ method: 'GET', strict: false })
  .validator((input: { id: string }) => input)
  .handler(async ({ data }): Promise<InvoiceDetail | null> => {
    const { ensureBooted } = await import('./boot')
    ensureBooted()
    const { invoices, payouts, audit, beneficiaries, settings } = await import('../store/repos')
    const { parseChecklist } = await import('../agent/checklist')
    const { serverEnv } = await import('../env')
    const { resolveExecutionMode } = await import('../payments/runner')
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
    const all = settings.all()
    return {
      invoice,
      checklist: parseChecklist(invoice.checklist_json),
      extracted,
      beneficiary: invoice.beneficiary_id ? beneficiaries.get(invoice.beneficiary_id) : null,
      payouts: payouts.byInvoice(invoice.id),
      audit: audit.list({ invoiceId: invoice.id, limit: 100 }),
      provider: { name: provider, label: PROVIDER_LABELS[provider] ?? provider },
      executionMode: await resolveExecutionMode(serverEnv.paymentExecutor()),
      mandate: { safeAddress: all.safeAddress ?? null, rolesProxy: all.rolesProxy ?? null, roleKey: all.roleKey ?? null },
    }
  })

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

export const retryInvoice = createServerFn({ method: 'POST' })
  .validator((input: { id: string }) => input)
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const { invoices, appendAudit } = await import('../store/repos')
    const { onInvoiceQueued } = await import('../integration')
    const invoice = invoices.get(data.id)
    if (!invoice) throw new Error('invoice not found')
    invoices.update(invoice.id, { status: 'queued', checklist_json: null, score: null, decision_text: null })
    appendAudit({ actor: 'owner', event: 'invoice.retried', invoiceId: invoice.id, details: { previous_status: invoice.status } })
    void onInvoiceQueued(invoice.id)
    return { ok: true }
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
  plan: MandatePlan
}

/** Creates (or updates) the beneficiary for a held invoice and returns the Safe tx the owner signs. */
export const approveBeneficiary = createServerFn({ method: 'POST' })
  .validator((input: ApproveBeneficiaryInput) => input)
  .handler(async ({ data }): Promise<ApproveBeneficiaryResult> => {
    const { isAddress, getAddress } = await import('viem')
    const { invoices, beneficiaries, appendAudit } = await import('../store/repos')
    const { planRegisterPayee } = await import('./mandate')
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
    const plan = await planRegisterPayee(beneficiary, data.monthlyLimitEur)
    return { beneficiary, plan }
  })

export interface ConfirmInstallInput {
  invoiceId: string
  beneficiaryId: string
  mode: 'install' | 'add_payee' | 'none'
  txHash: string | null
  rolesProxy: string | null
  roleKey: string | null
  mandateId: string | null
  simulated: boolean
}

/** After the owner's Safe tx (or its simulation): persist the mandate, activate the payee, approve the invoice. */
export const confirmInstall = createServerFn({ method: 'POST' })
  .validator((input: ConfirmInstallInput) => input)
  .handler(async ({ data }): Promise<{ payoutId: string | null; invoiceStatus: string }> => {
    const { invoices, beneficiaries, settings, appendAudit, agents } = await import('../store/repos')
    const { approveInvoice } = await import('../agent/service')
    const { runPaymentsOnce } = await import('../payments/runner')
    const { resolveAgentAddress } = await import('./mandate')
    const invoice = invoices.get(data.invoiceId)
    if (!invoice) throw new Error('invoice not found')
    const beneficiary = beneficiaries.get(data.beneficiaryId)
    if (!beneficiary) throw new Error('beneficiary not found')

    if (data.mode !== 'none') {
      if (!data.simulated && data.txHash) {
        if (data.mode === 'install') {
          settings.set('rolesProxy', data.rolesProxy)
          settings.set('roleKey', data.roleKey)
          settings.set('mandateId', data.mandateId)
          settings.set('installTxHash', data.txHash)
          const agent = await resolveAgentAddress()
          if (agent) settings.set('agentAddress', agent)
        }
      } else {
        settings.set('mandateSimulated', JSON.stringify({ mode: data.mode, rolesProxy: data.rolesProxy, roleKey: data.roleKey, mandateId: data.mandateId, at: new Date().toISOString() }))
      }
      appendAudit({
        actor: data.simulated ? 'owner' : 'chain',
        event: data.mode === 'install' ? 'mandate.installed' : 'mandate.payee_added',
        invoiceId: invoice.id,
        beneficiaryId: beneficiary.id,
        details: { tx_hash: data.txHash, roles_proxy: data.rolesProxy, role_key: data.roleKey, mandate_id: data.mandateId, simulated: data.simulated, limit_eur: beneficiary.monthly_limit_eur },
      })
    }
    beneficiaries.update(beneficiary.id, { status: 'active', trust_score: Math.max(beneficiary.trust_score, 70) })
    appendAudit({ actor: 'owner', event: 'beneficiary.activated', invoiceId: invoice.id, beneficiaryId: beneficiary.id, details: { wallet: beneficiary.wallet, monthly_limit_eur: beneficiary.monthly_limit_eur } })

    let payoutId: string | null = null
    if (invoice.status === 'needs_approval' || invoice.status === 'rejected' || invoice.status === 'failed') {
      const snapshot = parseSnapshot(invoice.checklist_json)
      const fails = snapshot?.entries.filter((e) => e.status === 'fail') ?? []
      if (fails.length > 0) {
        throw new Error(`Cannot approve: ${fails.map((f) => f.label).join(', ')} failed`)
      }
      const payout = approveInvoice(invoice.id)
      payoutId = payout.id
      agents.touch('compliance')
      void runPaymentsOnce()
    }
    const after = invoices.get(invoice.id)
    return { payoutId, invoiceStatus: after?.status ?? invoice.status }
  })

function parseSnapshot(json: string | null): ChecklistSnapshot | null {
  if (!json) return null
  try {
    return JSON.parse(json) as ChecklistSnapshot
  } catch {
    return null
  }
}
