// Server-only glue between the SQLite repos and the agent pipeline. This is what the API
// routes and the worker import; pipeline.ts itself stays storage-agnostic for tests.
//
//   const { processInvoice } = await import('@/lib/agent/service'); await processInvoice(invoiceId)
import { appendAudit, beneficiaries, invoices, payouts, settings } from '../store/repos'
import { approveAndEnqueue, type InvestigationResult, investigate } from './pipeline'
import type { AgentStore, AllowanceReader, PipelineDeps, ProgressEvent, TypedDataVerifier } from './types'
import { createWorker, processQueue, type Worker } from './worker'

if (typeof window !== 'undefined') {
  throw new Error('src/lib/agent/service.ts is server-only')
}

/** AgentStore over src/lib/store/repos.ts. */
export const repoStore: AgentStore = {
  getInvoice: (id) => invoices.get(id),
  updateInvoice: (id, patch) => {
    const { updated_at: _ignored, ...rest } = patch
    invoices.update(id, rest)
  },
  nextQueuedInvoice: () => invoices.nextQueued(),
  listBeneficiaries: () => beneficiaries.list(),
  getBeneficiary: (id) => beneficiaries.get(id),
  listInvoicesForBeneficiary: (beneficiaryId, excludeInvoiceId) =>
    invoices.list({ beneficiaryId, limit: 1000 }).filter((i) => i.id !== excludeInvoiceId),
  findInvoicesByNumber: (number, excludeInvoiceId) => invoices.byNumber(number, excludeInvoiceId),
  listPayoutsSince: (beneficiaryId, sinceIso) =>
    payouts.list({ limit: 1000 }).filter((p) => p.beneficiary_id === beneficiaryId && p.created_at >= sinceIso),
  createPayout: (payout) => payouts.create(payout),
  appendAudit: (event) =>
    void appendAudit({
      actor: event.actor,
      event: event.event,
      invoiceId: event.invoice_id ?? null,
      beneficiaryId: event.beneficiary_id ?? null,
      details: event.details,
    }),
  getSetting: (key) => settings.get(key),
}

export interface ServiceOptions {
  /** Reads the live Roles allowance for a beneficiary (src/lib/roles/allowance.ts); optional. */
  readAllowance?: AllowanceReader
  /** viem PublicClient for EIP-1271 signature checks; optional. */
  verifier?: TypedDataVerifier
  onProgress?: (event: ProgressEvent) => void
}

const options: ServiceOptions = {}

/** Call once at boot (e.g. from the chain module) to plug in the allowance reader and verifier. */
export const configureAgentService = (next: ServiceOptions): void => {
  Object.assign(options, next)
}

const deps = (): PipelineDeps => ({
  store: repoStore,
  readAllowance: options.readAllowance,
  verifier: options.verifier,
  onProgress: options.onProgress,
})

/** Investigate one invoice now (used right after upload). Safe to call for an already-queued id. */
export const processInvoice = (invoiceId: string): Promise<InvestigationResult> => investigate(invoiceId, deps())

/** Owner approved a held invoice after registering the payee: enqueue its payout. */
export const approveInvoice = (invoiceId: string) => approveAndEnqueue(invoiceId, deps())

/** Process the next queued invoice, if any (the "Run now" button). */
export const runQueueOnce = () => processQueue(deps())

let worker: Worker | null = null

/** Interval worker (every 5 s). Idempotent. */
export const agentWorker = (): Worker => {
  if (!worker) worker = createWorker(deps())
  return worker
}
