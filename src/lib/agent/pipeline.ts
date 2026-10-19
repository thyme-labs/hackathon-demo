// investigate(invoiceId, deps): extraction -> beneficiary match -> checks (with progress)
// -> score -> status -> explanation -> payout enqueue when approved.
// The LLM is untrusted: the recipient wallet always comes from the beneficiary registry.
import { readFileSync } from 'node:fs'
import { parseUnits } from 'viem'
import { CHECKS, type CheckContext, type LlmCallRecord } from './checks'
import { agentEnv } from './env'
import { explainDecision } from './explain'
import { ExtractedInvoice, extractInvoice } from './extract'
import { czkLeg } from './fx'
import { listVersions } from './lists'
import { matchBeneficiary } from './match'
import { getLlmProvider } from './providers'
import { computeScore, decideStatus, suggestMonthlyLimit } from './score'
import type {
  BeneficiaryProposal,
  BeneficiaryRow,
  CheckResult,
  ChecklistEntry,
  ChecklistSnapshot,
  InvoiceRow,
  NewPayout,
  PayoutRow,
  PipelineDecision,
  PipelineDeps,
} from './types'

const EURC_DECIMALS = 6

export interface InvestigationResult {
  invoice: InvoiceRow
  beneficiary: BeneficiaryRow | null
  decision: PipelineDecision
  score: number
  results: CheckResult[]
  payout: PayoutRow | null
  decisionText: string
}

const pendingEntries = (): ChecklistEntry[] =>
  CHECKS.map((c) => ({ id: c.id, label: c.label, enforcement: c.enforcement, weight: c.weight, status: 'pending', evidence: '', source: '', at: null }))

const toEntry = (r: CheckResult): ChecklistEntry => ({ ...r })

const llmSummary = (providerName: string, calls: LlmCallRecord[]): ChecklistSnapshot['llm'] => ({
  provider: providerName,
  calls: calls.length,
  cost_usd: Math.round(calls.reduce((s, c) => s + c.costUsd, 0) * 1e6) / 1e6,
  models: [...new Set(calls.map((c) => c.modelId))],
})

const loadExtraction = async (
  invoice: InvoiceRow,
  deps: PipelineDeps,
  llmCalls: LlmCallRecord[],
): Promise<ExtractedInvoice> => {
  if (invoice.extracted_json) {
    const parsed = ExtractedInvoice.safeParse(JSON.parse(invoice.extracted_json))
    if (parsed.success) return parsed.data
  }
  if (!invoice.file_path) throw new Error('invoice has no file_path and no stored extraction')
  deps.onProgress?.({ type: 'extracting', invoiceId: invoice.id })
  const bytes = new Uint8Array(readFileSync(invoice.file_path))
  const outcome = await extractInvoice(bytes, getLlmProvider())
  llmCalls.push({ purpose: 'extract_invoice', modelId: outcome.modelId, costUsd: outcome.costUsd, latencyMs: outcome.latencyMs })
  deps.onProgress?.({ type: 'extracted', invoiceId: invoice.id, confidence: outcome.invoice.confidence, modelId: outcome.modelId })
  deps.store.appendAudit({
    actor: 'agent',
    invoice_id: invoice.id,
    event: 'invoice.extracted',
    details: { model: outcome.modelId, cost_usd: outcome.costUsd, latency_ms: outcome.latencyMs, confidence: outcome.invoice.confidence, number: outcome.invoice.invoice.number },
  })
  return outcome.invoice
}

const proposalFor = (extracted: ExtractedInvoice, amountEur: number | null): BeneficiaryProposal => ({
  name: extracted.payee.name,
  type: extracted.payee.lei ? 'company' : /\b(ltd|limited|llc|gmbh|s\.?r\.?o|inc|plc|oü|d\.?o\.?o)\b/i.test(extracted.payee.name) ? 'company' : 'person',
  country: extracted.payee.country,
  tax_id: extracted.payee.tax_id,
  wallet: extracted.payment.wallet,
  email: extracted.payee.email ?? null,
  website: extracted.payee.website ?? null,
  lei: extracted.payee.lei ?? null,
  suggested_limit_eur: suggestMonthlyLimit(amountEur ?? extracted.invoice.gross),
})

/** Enqueues the payout for an approved invoice. Recipient = beneficiary.wallet, never the PDF. */
export const enqueuePayout = (
  invoice: InvoiceRow,
  beneficiary: BeneficiaryRow,
  deps: PipelineDeps,
  cnb: { czkPerUnit: number; validFor: string } | null,
): PayoutRow => {
  if (!beneficiary.wallet) throw new Error(`beneficiary ${beneficiary.id} has no wallet on file`)
  const amountEur = Math.round((invoice.amount_eur ?? invoice.amount ?? 0) * 100) / 100
  const payout: NewPayout = {
    invoice_id: invoice.id,
    beneficiary_id: beneficiary.id,
    // 1 EURC = 1 EUR; stored as base units (6 dp) like the rest of the app.
    amount_eurc: parseUnits(amountEur.toFixed(EURC_DECIMALS), EURC_DECIMALS).toString(),
    amount_eur: amountEur,
    currency: invoice.currency ?? 'EUR',
    fx_rate: invoice.fx_rate ?? 1,
    cnb_rate: cnb?.czkPerUnit ?? null,
    cnb_valid_for: cnb?.validFor ?? null,
    amount_czk: czkLeg(amountEur, cnb ? { currencyCode: 'EUR', czkPerUnit: cnb.czkPerUnit, validFor: cnb.validFor, requestedDate: cnb.validFor, source: 'cnb' } : null),
    // Thyme Flow is the only rail; a payout recorded without a chain transaction carries simulated = 1 instead.
    executor: 'thyme',
    status: 'pending',
  }
  const row = deps.store.createPayout(payout)
  deps.store.appendAudit({
    actor: 'agent',
    invoice_id: invoice.id,
    beneficiary_id: beneficiary.id,
    event: 'payout.enqueued',
    details: { payout_id: row.id, amount_eurc: row.amount_eurc, amount_eur: row.amount_eur, to: beneficiary.wallet, executor: row.executor },
  })
  return row
}

export const investigate = async (invoiceId: string, deps: PipelineDeps): Promise<InvestigationResult> => {
  const now = deps.now ?? (() => new Date())
  const store = deps.store
  const provider = getLlmProvider()
  const threshold = deps.autoPayThreshold ?? agentEnv.autoPayThreshold()
  const started = now()
  const initial = store.getInvoice(invoiceId)
  if (!initial) throw new Error(`invoice ${invoiceId} not found`)
  const llmCalls: LlmCallRecord[] = []
  const versions = await listVersions()
  let snapshot: ChecklistSnapshot = {
    entries: pendingEntries(),
    score: null,
    started_at: started.toISOString(),
    finished_at: null,
    list_versions: versions,
    llm: llmSummary(provider.name, llmCalls),
  }
  const persist = (patch: Partial<InvoiceRow> = {}): void => {
    store.updateInvoice(invoiceId, { ...patch, checklist_json: JSON.stringify(snapshot), updated_at: now().toISOString() })
  }
  persist({ status: 'investigating' })
  store.appendAudit({ actor: 'agent', invoice_id: invoiceId, event: 'investigation.started', details: { provider: provider.name } })

  try {
    const extracted = await loadExtraction(initial, deps, llmCalls)
    snapshot = { ...snapshot, llm: llmSummary(provider.name, llmCalls) }
    persist({
      extracted_json: JSON.stringify(extracted),
      number: extracted.invoice.number,
      issue_date: extracted.invoice.issue_date,
      due_date: extracted.invoice.due_date,
      currency: extracted.invoice.currency,
      amount: extracted.invoice.gross,
      payee_name: extracted.payee.name,
      payee_wallet: extracted.payment.wallet,
    })

    const { beneficiary, matchedBy } = matchBeneficiary(extracted, store.listBeneficiaries())
    deps.onProgress?.({ type: 'matched', invoiceId, beneficiaryId: beneficiary?.id ?? null })
    persist({ beneficiary_id: beneficiary?.id ?? null })

    const invoice = store.getInvoice(invoiceId) ?? initial
    const ctx: CheckContext = { invoice, extracted, beneficiary, matchedBy, store, deps, provider, now: now(), out: {}, llmCalls }
    const results: CheckResult[] = []
    for (const check of CHECKS) {
      deps.onProgress?.({ type: 'check_started', invoiceId, checkId: check.id })
      snapshot = { ...snapshot, entries: snapshot.entries.map((e) => (e.id === check.id ? { ...e, status: 'running' } : e)) }
      persist()
      let result: CheckResult
      try {
        result = await check.run(ctx)
      } catch (error) {
        result = {
          id: check.id,
          label: check.label,
          enforcement: check.enforcement,
          weight: check.weight,
          status: 'fail',
          evidence: `Check crashed: ${error instanceof Error ? error.message : String(error)}`,
          source: 'agent runtime',
          at: now().toISOString(),
        }
      }
      results.push(result)
      snapshot = {
        ...snapshot,
        entries: snapshot.entries.map((e) => (e.id === check.id ? toEntry(result) : e)),
        llm: llmSummary(provider.name, llmCalls),
      }
      const fxPatch = check.id === 'fx_rate' && ctx.out.fx
        ? { amount_eur: ctx.out.amountEur ?? null, fx_rate: ctx.out.fx.quote.rateToEur, fx_source: ctx.out.fx.quote.source, fx_at: ctx.out.fx.quote.at }
        : {}
      persist(fxPatch)
      deps.onProgress?.({ type: 'check_done', invoiceId, result })
    }

    const summary = computeScore(results)
    const decision = decideStatus(summary, beneficiary, threshold)
    const amountEur = ctx.out.amountEur ?? (extracted.invoice.currency === 'EUR' ? extracted.invoice.gross : null)
    const explanation = await explainDecision({ extracted, beneficiary, results, score: summary.score, decision, amountEur }, provider)
    if (explanation.modelId !== 'none') {
      llmCalls.push({ purpose: 'explain', modelId: explanation.modelId, costUsd: explanation.costUsd, latencyMs: explanation.latencyMs })
    }
    snapshot = {
      ...snapshot,
      score: summary.score,
      finished_at: now().toISOString(),
      llm: llmSummary(provider.name, llmCalls),
      ...(beneficiary ? {} : { proposal: proposalFor(extracted, amountEur) }),
    }
    persist({ status: decision, score: summary.score, decision_text: explanation.text })
    deps.onProgress?.({ type: 'decided', invoiceId, decision, score: summary.score })
    store.appendAudit({
      actor: 'agent',
      invoice_id: invoiceId,
      beneficiary_id: beneficiary?.id ?? null,
      event: `invoice.${decision}`,
      details: {
        score: summary.score,
        fails: summary.fails.map((f) => f.id),
        warns: summary.warns.map((w) => w.id),
        llm_cost_usd: snapshot.llm.cost_usd,
        elapsed_ms: now().getTime() - started.getTime(),
      },
    })

    const final = store.getInvoice(invoiceId) ?? invoice
    let payout: PayoutRow | null = null
    if (decision === 'approved' && beneficiary) {
      payout = enqueuePayout(final, beneficiary, deps, ctx.out.cnb ?? null)
    }
    return { invoice: final, beneficiary, decision, score: summary.score, results, payout, decisionText: explanation.text }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    snapshot = { ...snapshot, finished_at: now().toISOString(), llm: llmSummary(provider.name, llmCalls) }
    persist({ status: 'needs_approval', decision_text: `Agent could not complete the investigation: ${message}. Owner review required.` })
    store.appendAudit({ actor: 'agent', invoice_id: invoiceId, event: 'investigation.error', details: { message } })
    deps.onProgress?.({ type: 'error', invoiceId, message })
    throw error
  }
}

/** Owner approved a held invoice (and registered the beneficiary): enqueue the payout. */
export const approveAndEnqueue = (invoiceId: string, deps: PipelineDeps): PayoutRow => {
  const invoice = deps.store.getInvoice(invoiceId)
  if (!invoice) throw new Error(`invoice ${invoiceId} not found`)
  if (!invoice.beneficiary_id) throw new Error('invoice has no beneficiary; register the payee first')
  const beneficiary = deps.store.getBeneficiary(invoice.beneficiary_id)
  if (!beneficiary) throw new Error('beneficiary not found')
  let cnb: { czkPerUnit: number; validFor: string } | null = null
  if (invoice.checklist_json) {
    const snap = JSON.parse(invoice.checklist_json) as ChecklistSnapshot
    const fx = snap.entries.find((e) => e.id === 'fx_rate')?.data as { cnb?: { czkPerUnit: number; validFor: string } | null } | undefined
    cnb = fx?.cnb ?? null
  }
  deps.store.updateInvoice(invoiceId, { status: 'approved', updated_at: new Date().toISOString() })
  deps.store.appendAudit({ actor: 'owner', invoice_id: invoiceId, beneficiary_id: beneficiary.id, event: 'invoice.approved_by_owner' })
  return enqueuePayout({ ...invoice, status: 'approved' }, beneficiary, deps, cnb)
}
