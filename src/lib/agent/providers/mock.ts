// Deterministic provider so the whole app works with no keys and no network.
// extract_invoice: reads the JSON the demo generator stored in the PDF Subject
// metadata (demo/make-invoices.ts). Unknown PDFs yield a low-confidence stub.
// write_decision / assess_footprint: templated from demo/payees.json.
import { PDFDocument } from 'pdf-lib'
import demoPayees from '../../../../demo/payees.json'
import type { ConverseRequest, ConverseResult, LlmProvider, ToolCall } from './types'

export interface DemoPayee {
  id: string
  name: string
  printed_name: string
  type: 'person' | 'company'
  country: string
  tax_id: string
  wallet: string
  email: string | null
  lei: string | null
  website: string | null
  /** Registered payees only; the unregistered ones (new-payee scenarios) carry no limit. */
  monthly_limit_eur?: number
  currency?: string
  address: string
  footprint: { exists: boolean; matches_country: boolean; fraud_reports: boolean; summary: string }
}

// `payees` are the registered beneficiaries; `unregistered_payees` only appear on scenario invoices
// (sanctioned wallet/name, high-risk countries, IBAN-only). Both have a scripted public footprint.
const payees = demoPayees as unknown as { payees: DemoPayee[]; unregistered_payees?: DemoPayee[] }
const corpus = (): DemoPayee[] => [...payees.payees, ...(payees.unregistered_payees ?? [])]

const MOCK_MODEL_IDS = { extract: 'mock/extract', reason: 'mock/reason' } as const

const normalise = (s: string): string =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')

export const findDemoPayeeByName = (name: string): DemoPayee | undefined => {
  const n = normalise(name)
  return corpus().find((p) => normalise(p.name) === n || normalise(p.printed_name) === n)
}

const readPdfSubject = async (bytes: Uint8Array): Promise<string | null> => {
  try {
    const doc = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true })
    return doc.getSubject() ?? null
  } catch {
    return null
  }
}

const stubExtraction = (): Record<string, unknown> => ({
  payee: { name: 'Unknown payee', address: '', country: '', tax_id: null, lei: null, email: null, website: null },
  invoice: { number: 'UNKNOWN', issue_date: null, due_date: null, currency: 'EUR', net: 0, vat: 0, gross: 0, line_items: [] },
  payment: { wallet: null, chain: null, iban: null, bic: null, token: null },
  notes: null,
  suspicious_text: [],
  confidence: 0.1,
})

const mockExtract = async (request: ConverseRequest): Promise<Record<string, unknown>> => {
  const doc = request.messages.flatMap((m) => m.content).find((c) => c.type === 'document')
  if (!doc || doc.type !== 'document') return stubExtraction()
  const subject = await readPdfSubject(doc.bytes)
  if (!subject) return stubExtraction()
  try {
    const parsed = JSON.parse(subject) as Record<string, unknown>
    return parsed.payee && parsed.invoice ? parsed : stubExtraction()
  } catch {
    return stubExtraction()
  }
}

const lastUserText = (request: ConverseRequest): string =>
  request.messages
    .filter((m) => m.role === 'user')
    .flatMap((m) => m.content)
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('\n')

const mockFootprint = (request: ConverseRequest): Record<string, unknown> => {
  const text = lastUserText(request)
  const match = /beneficiary name:\s*(.+)/i.exec(text)
  const payee = match ? findDemoPayeeByName(match[1].trim()) : undefined
  if (!payee) {
    return { exists: false, matches_country: false, fraud_reports: false, summary: 'No public footprint found in the mock corpus.', confidence: 0.3 }
  }
  return { ...payee.footprint, confidence: 0.8 }
}

const mockDecision = (request: ConverseRequest): Record<string, unknown> => {
  const text = lastUserText(request)
  const decision = /decision:\s*(\w+)/i.exec(text)?.[1] ?? 'needs_approval'
  const score = /score:\s*(\d+(?:\.\d+)?)/i.exec(text)?.[1] ?? '?'
  const fails = [...text.matchAll(/^- \[fail\] (.+?) \((?:chain|agent)\):/gim)].map((m) => m[1])
  const warns = [...text.matchAll(/^- \[warn\] (.+?) \((?:chain|agent)\):/gim)].map((m) => m[1])
  const parts: string[] = []
  if (decision === 'approved') parts.push(`All checks passed (score ${score}). Payout released to the wallet on file.`)
  else if (decision === 'rejected') parts.push(`Stopped: ${fails.join(', ') || 'a blocking check failed'}. No money moved.`)
  else parts.push(`Held for owner review (score ${score}).`)
  if (warns.length) parts.push(`Review items: ${warns.join(', ')}.`)
  return { decision_text: parts.join(' ') }
}

export const createMockProvider = (): LlmProvider => ({
  name: 'mock',
  async converse(request: ConverseRequest): Promise<ConverseResult> {
    const started = Date.now()
    const forced = request.toolChoice?.type === 'tool' ? request.toolChoice.name : request.tools?.[0]?.name
    const toolCalls: ToolCall[] = []
    let text = ''
    if (forced === 'extract_invoice') {
      toolCalls.push({ id: 'mock-1', name: forced, input: await mockExtract(request) })
    } else if (forced === 'assess_footprint') {
      toolCalls.push({ id: 'mock-1', name: forced, input: mockFootprint(request) })
    } else if (forced === 'write_decision') {
      toolCalls.push({ id: 'mock-1', name: forced, input: mockDecision(request) })
    } else {
      text = 'Mock provider: no tool requested.'
    }
    const modelId = MOCK_MODEL_IDS[request.model]
    return {
      toolCalls,
      text,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      modelId,
      costUsd: 0,
      latencyMs: Date.now() - started,
      stopReason: toolCalls.length ? 'tool_use' : 'end_turn',
    }
  },
})
