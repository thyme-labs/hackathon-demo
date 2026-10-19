// Did the payee's wallet or limit change recently, and is this the first payout after it? Reads the audit log
// (SQLite audit_log, mirrored to the hash-chained JSONL): beneficiary.registered / updated / activated carry the
// wallet and the monthly limit, owner.wallet_primary_set moves the payout wallet, owner.override is noted.
// Change-of-bank-details fraud pattern: the first payment after a detail change is the one that goes astray.
import type { AuditRow } from '../types'
import { type CheckContext, type CheckSpec, eur, makeResult, shortAddr } from './context'

const spec = { id: 'payee_detail_change', label: 'Payee details stable', enforcement: 'agent', weight: 6 } as const

const DAY_MS = 86_400_000
const WALLET_EVENTS: ReadonlySet<string> = new Set(['beneficiary.registered', 'beneficiary.updated', 'beneficiary.activated', 'owner.wallet_primary_set'])
const LIMIT_EVENTS: ReadonlySet<string> = new Set(['beneficiary.registered', 'beneficiary.updated', 'beneficiary.activated'])
/** First payout within this window of the registration is held above the cooling cap. */
const COOLING_WINDOW_MS = 24 * 3_600_000
const COOLING_CAP_EUR = 500
const RECENT_MS = 7 * DAY_MS

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const day = (iso: string): string => iso.slice(0, 10)
const ms = (iso: string): number => Date.parse(iso)
const hoursText = (fromIso: string, now: Date): string => {
  const h = (now.getTime() - ms(fromIso)) / 3_600_000
  return h < 1 ? '< 1 h' : `${Math.round(h)} h`
}

interface WalletChange {
  at: string
  from: string
  to: string
  actor: string
  invoice_id: string | null
}

const walletChanges = (events: AuditRow[]): WalletChange[] => {
  const seq = events
    .filter((e) => WALLET_EVENTS.has(e.event) && str(e.details.wallet))
    .map((e) => ({ at: e.ts, actor: e.actor, invoice_id: e.invoice_id, wallet: (str(e.details.wallet) as string).toLowerCase() }))
  const changes: WalletChange[] = []
  for (let i = 1; i < seq.length; i++) {
    const prev = seq[i - 1]
    const cur = seq[i]
    if (prev.wallet !== cur.wallet) changes.push({ at: cur.at, from: prev.wallet, to: cur.wallet, actor: cur.actor, invoice_id: cur.invoice_id })
  }
  return changes
}

const limitRaises = (events: AuditRow[]): { at: string; from: number; to: number; actor: string }[] => {
  const seq = events.filter((e) => LIMIT_EVENTS.has(e.event) && num(e.details.monthly_limit_eur) !== null).map((e) => ({ at: e.ts, actor: e.actor, limit: num(e.details.monthly_limit_eur) as number }))
  const raises: { at: string; from: number; to: number; actor: string }[] = []
  for (let i = 1; i < seq.length; i++) {
    const prev = seq[i - 1]
    const cur = seq[i]
    if (prev.limit > 0 && cur.limit > 2 * prev.limit) raises.push({ at: cur.at, from: prev.limit, to: cur.limit, actor: cur.actor })
  }
  return raises
}

export const run = async (ctx: CheckContext) => {
  const b = ctx.beneficiary
  if (!b) {
    return makeResult(spec, ctx, { status: 'skip', evidence: 'No registry entry yet; the registration will be the baseline.', source: 'audit_log (beneficiary events)' })
  }
  if (typeof ctx.store.listAudit !== 'function') {
    return makeResult(spec, ctx, { status: 'skip', evidence: 'This store exposes no audit trail to the agent; nothing to compare the registration with.', source: 'audit_log (beneficiary events)' })
  }
  const events = [...ctx.store.listAudit(b.id)].sort((x, y) => ms(x.ts) - ms(y.ts))
  const nowMs = ctx.now.getTime()
  const firstTs = events[0]?.ts ?? b.created_at
  const source = `audit_log for ${b.name}: ${events.length} events since ${day(firstTs)}`

  const changes = walletChanges(events)
  const latestChange = changes.at(-1) ?? null
  const recentChange = latestChange && nowMs - ms(latestChange.at) < RECENT_MS ? latestChange : null
  const raises = limitRaises(events).filter((r) => nowMs - ms(r.at) < RECENT_MS)
  const registeredAt = events.find((e) => e.event === 'beneficiary.registered')?.ts ?? b.created_at
  const confirmed = ctx.store.listPayoutsSince(b.id, '1970-01-01T00:00:00.000Z').filter((p) => p.status === 'confirmed')
  const amountEur = ctx.out.amountEur ?? (ctx.extracted.invoice.currency === 'EUR' ? ctx.extracted.invoice.gross : null)
  const cap = Math.min(COOLING_CAP_EUR, 0.5 * b.monthly_limit_eur)
  const sinceRegistration = nowMs - ms(registeredAt)
  const cooling = confirmed.length === 0 && sinceRegistration >= 0 && sinceRegistration < COOLING_WINDOW_MS && amountEur !== null && amountEur > cap
  const overrides = events.filter((e) => e.event === 'owner.override' && nowMs - ms(e.ts) < RECENT_MS)

  const data = {
    events: events.length,
    registered_at: registeredAt,
    wallet_changes: changes,
    limit_raises_7d: raises,
    first_payout: confirmed.length === 0,
    cooling_cap_eur: cap,
    amount_eur: amountEur,
    overrides_7d: overrides.length,
  }

  const findings: string[] = []
  if (recentChange) {
    const sameInvoice = recentChange.invoice_id === ctx.invoice.id
    findings.push(
      `Wallet changed on ${day(recentChange.at)} (${hoursText(recentChange.at, ctx.now)} ago) from ${shortAddr(recentChange.from)} to ${shortAddr(recentChange.to)} by ${recentChange.actor}${sameInvoice ? ' while handling this invoice' : ''}; first payout after a detail change is held (change-of-bank-details fraud pattern).`,
    )
  }
  for (const r of raises) {
    findings.push(`Monthly limit raised from ${eur(r.from)} to ${eur(r.to)} on ${day(r.at)} by ${r.actor}; owner review.`)
  }
  if (cooling && amountEur !== null) {
    findings.push(
      `First payout ${eur(amountEur)} within ${hoursText(registeredAt, ctx.now)} of registration exceeds the cooling cap ${eur(cap)} (min of EUR 500 and 50 % of the limit).`,
    )
  }
  const overrideNote = overrides.length > 0 ? ` ${overrides.length} owner override(s) in the last 7 days.` : ''
  if (findings.length > 0) {
    return makeResult(spec, ctx, { status: 'warn', evidence: `${findings.join(' ')}${overrideNote}`, source, data })
  }
  const walletLine = latestChange
    ? `Wallet ${shortAddr(b.wallet)} on file since ${day(latestChange.at)} (changed by ${latestChange.actor}, ${Math.round((nowMs - ms(latestChange.at)) / DAY_MS)} d ago; ${events.length} audit events)`
    : `Wallet ${shortAddr(b.wallet)} unchanged since registration ${day(registeredAt)} (${events.length} audit events)`
  return makeResult(spec, ctx, {
    status: 'pass',
    evidence: `${walletLine}; limit ${eur(b.monthly_limit_eur)}/30 d unchanged.${overrideNote}`,
    source,
    data,
  })
}

export const payeeDetailChange: CheckSpec = { ...spec, run }
