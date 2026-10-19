// Server-only glue between the store and src/lib/reports.
import { appendJsonl, auditLogPath, buildComparisonCard, buildRemittanceAdvice, currentMonth, ledgerCsv, payoutMonth, readAll, staticSources, toJsonl, verifyChain } from '../reports'
import type { ChecklistItem, NetworkFee } from '../reports/types'
import { finishedEntries, parseChecklist } from '../agent/checklist'
import { serverEnv } from '../env'
import { audit, beneficiaries, invoices, payouts, settings } from '../store/repos'
import type { Payout } from '../store/types'
import type { ReportsView } from './dto'

if (typeof window !== 'undefined') {
  throw new Error('src/lib/server/reports.ts is server-only')
}

const feeOf = (p: Payout): NetworkFee | null => {
  if (p.simulated) return { gasUsed: p.gas_used, effectiveGasPriceWei: 0, feeEth: 0, feeEur: 0 }
  if (!p.gas_used) return null
  return { gasUsed: p.gas_used, effectiveGasPriceWei: p.effective_gas_price_wei ?? null }
}

export function buildRemittance(payoutId: string): string {
  const payout = payouts.get(payoutId)
  if (!payout) throw new Error('payout not found')
  const invoice = invoices.get(payout.invoice_id)
  if (!invoice) throw new Error('invoice not found')
  const beneficiary = (payout.beneficiary_id ? beneficiaries.get(payout.beneficiary_id) : null) ?? {
    id: 'unknown',
    name: invoice.payee_name ?? 'Unknown payee',
    type: 'person' as const,
    country: null,
    wallet: invoice.payee_wallet,
    status: 'new' as const,
  }
  const snapshot = parseChecklist(invoice.checklist_json)
  const checklist: ChecklistItem[] = finishedEntries(snapshot).map((e) => ({
    id: e.id,
    label: e.label,
    status: e.status as ChecklistItem['status'],
    enforcement: e.enforcement,
    weight: e.weight,
    evidence: e.evidence,
    source: e.source,
    at: e.at,
  }))
  const all = settings.all()
  const provider = serverEnv.llmProvider()
  const modelId = snapshot.llm.models.find((m) => /sonnet|reason/i.test(m)) ?? snapshot.llm.models[0] ?? null
  return buildRemittanceAdvice(payout, invoice, beneficiary, checklist, {
    payer: { legalName: 'Thyme Payroll demo company', safeAddress: all.safeAddress ?? undefined },
    mandate: {
      executor: payout.executor,
      label: payout.simulated ? 'SIMULATED (no chain transaction)' : undefined,
      rolesModule: all.thymeRolesProxy ?? undefined,
      capEur: beneficiary && 'monthly_limit_eur' in beneficiary ? beneficiary.monthly_limit_eur : null,
      thymeExecutionId: payout.thyme_execution_id,
      mandateTxHash: all.thymeSetupTxHash ?? null,
      thymeProfileId: all.thymeProfileId ?? null,
    },
    fee: feeOf(payout),
    aiSummary: invoice.decision_text,
    modelId: provider === 'mock' ? 'mock (no model call)' : modelId,
    appUrl: serverEnv.appUrl(),
    datasetVersions: Object.entries(snapshot.list_versions).map(([name, version]) => ({ name, version })),
  })
}

export function buildLedgerCsv(month: string | null): string {
  const period = month ?? currentMonth()
  const inv = new Map(invoices.list({ limit: 2000 }).map((i) => [i.id, i]))
  const ben = new Map(beneficiaries.list().map((b) => [b.id, b]))
  const rows = payouts
    .list({ limit: 2000 })
    .filter((p) => payoutMonth(p) === period)
    .reverse()
    .map((p) => ({ payout: p, invoice: inv.get(p.invoice_id) ?? null, beneficiary: p.beneficiary_id ? (ben.get(p.beneficiary_id) ?? null) : null, fee: feeOf(p) }))
  return ledgerCsv(rows)
}

export function buildAuditJsonl(): string {
  const records = readAll(auditLogPath())
  if (records.length > 0) return toJsonl(records)
  // No JSONL yet (fresh volume): seed it from the SQLite rows so the export is never empty.
  for (const row of audit.list({ limit: 5000 }).reverse()) {
    let details: Record<string, unknown> = {}
    try {
      details = row.details_json ? (JSON.parse(row.details_json) as Record<string, unknown>) : {}
    } catch {
      details = {}
    }
    appendJsonl({ ts: row.ts, actor: row.actor, event: row.event, invoice_id: row.invoice_id, beneficiary_id: row.beneficiary_id, details })
  }
  return toJsonl(readAll(auditLogPath()))
}

export function buildReportsView(month: string | null): ReportsView {
  const inv = new Map(invoices.list({ limit: 2000 }).map((i) => [i.id, i]))
  const ben = new Map(beneficiaries.list().map((b) => [b.id, b]))
  const all = payouts.list({ limit: 2000 })
  const months = [...new Set(all.map((p) => payoutMonth(p)).filter((m): m is string => Boolean(m)))].sort().reverse()
  const period = month ?? months[0] ?? currentMonth()
  const items = all
    .filter((p) => p.status === 'confirmed' || p.status === 'submitted')
    .map((p) => {
      const b = p.beneficiary_id ? ben.get(p.beneficiary_id) : undefined
      return {
        payout: p,
        country: b?.country ?? 'XX',
        fee: feeOf(p),
        invoiceNumber: inv.get(p.invoice_id)?.number ?? null,
        beneficiaryName: b?.name ?? inv.get(p.invoice_id)?.payee_name ?? null,
      }
    })
  const card = buildComparisonCard(items, { month: period })
  const sources = [...card.sources, ...staticSources()]
  const seen = new Set<string>()
  const chain = verifyChain(auditLogPath())
  return {
    month: period,
    months: months.length ? months : [period],
    comparison: {
      headline: card.headline,
      subline: card.subline,
      periodLabel: card.periodLabel,
      payouts: card.payouts,
      confirmed: card.confirmed,
      totalEur: card.totalEur,
      savedEur: card.savedEur,
      savedBusinessDays: card.savedBusinessDays,
      savedHours: card.savedHours,
      savedEurIfAllSwift: card.savedEurIfAllSwift,
      swiftCorridors: card.swiftCorridors,
      sepaCorridors: card.sepaCorridors,
      mainnetEquivalentFeeEur: card.mainnetEquivalentFeeEur,
      avgSettlementSeconds: card.avgSettlementSeconds,
      lines: card.lines.map((l) => ({
        payoutId: l.payoutId,
        invoiceNo: l.invoiceNo,
        beneficiary: l.beneficiary,
        country: l.country,
        sepa: l.sepa,
        amountEur: l.amountEur,
        baselineLabel: l.baselineLabel,
        baselineFeeEur: l.baselineFeeEur,
        eurcFeeEur: l.eurcFeeEur,
        savedEur: l.savedEur,
        savedBusinessDays: l.savedBusinessDays,
        sentence: l.sentence,
      })),
      sources: sources.filter((s) => (seen.has(s.key) ? false : (seen.add(s.key), true))).map((s) => ({ key: s.key, label: s.label, value: s.value, source_url: s.source_url, fetched_on: s.fetched_on, note: s.note })),
    },
    audit: audit.list({ limit: 150 }),
    chain: { ok: chain.ok, records: chain.count, message: chain.ok ? `${chain.count} records, hash chain intact` : `broken at record ${chain.brokenAt}: ${chain.reason}` },
  }
}
