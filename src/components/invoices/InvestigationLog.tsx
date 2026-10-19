import { Bot, Check, ChevronDown, ExternalLink, LoaderCircle, RefreshCw, RotateCcw, Send, ShieldAlert, Sparkles, TriangleAlert, X, Zap } from 'lucide-react'
import { useState } from 'react'
import { AddressMono } from '@/components/ui-kit/AddressMono'
import { CheckList } from '@/components/ui-kit/CheckList'
import { Chip } from '@/components/ui-kit/Chip'
import { formatDateTime, formatEur, formatEurc, formatMoney, formatTime, formatUsd, secondsBetween } from '@/components/ui-kit/format'
import { ScoreRing } from '@/components/ui-kit/ScoreRing'
import { StatusPill } from '@/components/ui-kit/StatusPill'
import { Logo } from '@/components/shell/Logo'
import { Button } from '@/components/ui/button'
import type { InvoiceDetail } from '@/lib/server/dto'
import { cn } from '@/lib/utils'

export type ApproveMode = 'hold' | 'send'

interface PayoutActions {
  /** Re-trigger Thyme for a failed / reverted / stuck payout with a new Idempotency-Key. */
  onRetryPayout: (payoutId: string) => void
  /** Re-read the Thyme execution recorded on the payout. */
  onCheckPayout: (payoutId: string) => void
  /** Mark a stuck payout as failed. */
  onDiscardPayout: (payoutId: string) => void
}

interface InvestigationLogProps extends PayoutActions {
  detail: InvoiceDetail
  /** New payee: open the register dialog (which offers Approve / Approve & send). */
  onRegister: () => void
  /** Known payee: approve and hold, or approve and queue the payout. */
  onApprove: (mode: ApproveMode) => void
  /** Release an approved invoice that was kept on hold. */
  onSend: () => void
  /** Re-run the checks from the stored PDF (keeps the beneficiary). */
  onRetry: () => void
  /** Rejected invoice: open the "Send anyway" modal (acknowledge every failed check, give a reason). */
  onOverride: () => void
  /** PAYMENT_EXECUTOR=simulated only: the labelled "what a fooled agent would do" demo. */
  onForce: () => void
  /** Mark the invoice (and any in-flight payout) as failed. */
  onDiscard: () => void
  busy: boolean
}

/** Chat-like investigation: upload bubble, decision card (score, reason, actions), extraction, checks by severity, payouts. */
export function InvestigationLog({ detail, onRegister, onApprove, onSend, onRetry, onOverride, onForce, onDiscard, onRetryPayout, onCheckPayout, onDiscardPayout, busy }: InvestigationLogProps) {
  const { invoice, checklist, extracted, beneficiary, payouts, provider, executionMode, audit } = detail
  const fileName = uploadedName(audit) ?? invoice.file_path?.split('/').pop() ?? 'invoice.pdf'
  const running = invoice.status === 'queued' || invoice.status === 'investigating'
  const finished = Boolean(checklist.finished_at)
  const payout = payouts.find((p) => p.status === 'confirmed') ?? payouts[0] ?? null
  const paidSeconds = payout?.confirmed_at ? secondsBetween(invoice.created_at, payout.confirmed_at) : null

  return (
    <div className="mx-auto w-full max-w-2xl">
      <div className="ml-24 rounded-2xl rounded-br-sm bg-raised px-5 py-4 text-sm leading-relaxed text-secondary-foreground">
        Invoice uploaded · <span className="font-mono text-xs">{fileName}</span>
        <div className="mt-1 text-xs text-dim">{formatDateTime(invoice.created_at)}</div>
      </div>

      <div className="mt-8 mb-4 text-sage">
        <Logo className="size-6" />
      </div>

      {!extracted && running ? (
        <Card>
          <Row icon={<LoaderCircle aria-hidden className="size-4 animate-spin text-sage" />}>Reading the PDF with {provider.label}…</Row>
        </Card>
      ) : null}

      {running ? (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-dim">
          <span>If this looks stuck:</span>
          <Button variant="ghost" size="sm" className="text-dim" onClick={onRetry} disabled={busy} title="Queue the invoice again from the stored PDF">
            <RotateCcw aria-hidden />
            Re-run checks
          </Button>
          <Button variant="ghost" size="sm" className="text-blocked hover:text-blocked" onClick={onDiscard} disabled={busy} title="Mark the invoice as failed">
            <X aria-hidden />
            Mark as failed
          </Button>
        </div>
      ) : null}

      {finished ? (
        <DecisionCard
          detail={detail}
          payoutSeconds={paidSeconds}
          onRegister={onRegister}
          onApprove={onApprove}
          onSend={onSend}
          onRetry={onRetry}
          onOverride={onOverride}
          onForce={onForce}
          onDiscard={onDiscard}
          onRetryPayout={onRetryPayout}
          onCheckPayout={onCheckPayout}
          onDiscardPayout={onDiscardPayout}
          busy={busy}
          executionLabel={executionMode.mode === 'simulated' ? `simulated · ${executionMode.reason}` : executionMode.reason}
        />
      ) : null}

      {extracted ? <ExtractionCard detail={detail} className={finished ? 'mt-3' : undefined} /> : null}

      {checklist.entries.length > 0 ? (
        <Card className="mt-3">
          <div className="flex items-center justify-between">
            <div className="text-xs text-dim">Checks · by severity</div>
            {beneficiary ? (
              <div className="text-xs text-dim">
                matched <span className="text-text">{beneficiary.name}</span> · <StatusPill status={beneficiary.status} />
              </div>
            ) : finished ? (
              <div className="text-xs text-paused">new payee</div>
            ) : null}
          </div>
          <CheckList entries={checklist.entries} className="mt-1" />
        </Card>
      ) : null}

      {payouts.length > 0 ? (
        <Card className="mt-3">
          <div className="text-xs text-dim">Payouts</div>
          <div className="mt-2 grid gap-2">
            {payouts.map((p) => (
              <div key={p.id} className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-3 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusPill status={p.status} />
                  {p.simulated ? <Chip tone="warn">simulated</Chip> : null}
                  {p.override ? (
                    <Chip tone="fail" title="Sent by the owner despite failed checks (audit owner.override)">
                      overridden
                    </Chip>
                  ) : null}
                  <span className="text-dim">{p.executor}</span>
                  {p.attempt > 1 ? <span className="text-dim">· attempt {p.attempt}</span> : null}
                </div>
                <span className="font-mono">{formatEurc(p.amount_eurc)} EURC</span>
                {p.tx_hash ? <AddressMono value={p.tx_hash} kind="tx" link={!p.simulated} /> : <span className="text-dim">{formatTime(p.created_at)}</span>}
                <div className="flex justify-end gap-1">
                  {p.status === 'failed' || p.status === 'reverted' ? (
                    <Button variant="ghost" size="icon-xs" className="text-dim" onClick={() => onRetryPayout(p.id)} disabled={busy} aria-label="Retry payout" title="Retry payout (new Idempotency-Key)">
                      <RotateCcw aria-hidden />
                    </Button>
                  ) : null}
                  {p.status === 'pending' || p.status === 'submitted' ? (
                    <>
                      <Button variant="ghost" size="icon-xs" className="text-dim" onClick={() => onCheckPayout(p.id)} disabled={busy} aria-label="Check status" title="Re-read the Thyme execution">
                        <RefreshCw aria-hidden />
                      </Button>
                      <Button variant="ghost" size="icon-xs" className="text-blocked hover:text-blocked" onClick={() => onDiscardPayout(p.id)} disabled={busy} aria-label="Discard payout" title="Mark as failed">
                        <X aria-hidden />
                      </Button>
                    </>
                  ) : null}
                </div>
                {p.error ? <div className="col-span-4 break-words text-blocked">{p.error}</div> : null}
              </div>
            ))}
          </div>
        </Card>
      ) : null}
    </div>
  )
}

/** `eu.anthropic.claude-haiku-4-5-20251001-v1:0` → `claude-haiku-4-5 · Bedrock eu`. */
function shortModelId(modelId: string): string {
  const match = modelId.match(/^(?:(?<region>[a-z]{2})\.)?anthropic\.(?<model>claude-[a-z]+-\d+-\d+)/)
  if (!match?.groups) return modelId
  const region = match.groups.region ? ` · Bedrock ${match.groups.region}` : ''
  return `${match.groups.model}${region}`
}

function uploadedName(audit: InvoiceDetail['audit']): string | null {
  const row = audit.find((a) => a.event === 'invoice.uploaded')
  if (!row?.details_json) return null
  try {
    const d = JSON.parse(row.details_json) as { name?: string }
    return d.name ?? null
  } catch {
    return null
  }
}

function Card({ children, className }: { children: React.ReactNode; className?: string }) {
  return <section className={cn('rounded-xl bg-surface p-5', className)}>{children}</section>
}

function Row({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 text-sm text-secondary-foreground">
      {icon}
      {children}
    </div>
  )
}

function ExtractionCard({ detail, className }: { detail: InvoiceDetail; className?: string }) {
  const { extracted, checklist, provider } = detail
  if (!extracted) return null
  return (
    <Card className={cn('animate-rise', className)}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-xs text-dim">Extraction</div>
          <h3 className="mt-1 text-base font-medium">{extracted.payee.name}</h3>
          <div className="mt-0.5 text-xs text-dim">
            {extracted.payee.country || '—'} · {extracted.payee.tax_id ?? 'no tax id'} · {extracted.payee.address}
          </div>
        </div>
        <div className="text-right">
          <div className="font-mono text-2xl tracking-tightest">{formatMoney(extracted.invoice.gross, extracted.invoice.currency)}</div>
          <div className="mt-0.5 text-xs text-dim">
            {extracted.invoice.number} · due {extracted.invoice.due_date ?? '—'}
          </div>
        </div>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3 text-xs">
        <div>
          <div className="text-dim">Wallet on the invoice</div>
          <div className="mt-1">{extracted.payment.wallet ? <AddressMono value={extracted.payment.wallet} /> : <span className="text-dim">none</span>}</div>
        </div>
        <div>
          <div className="text-dim">Confidence</div>
          <div className="mt-1 font-mono">{Math.round(extracted.confidence * 100)}%</div>
          <div className="mt-2 text-dim">Model</div>
          <div className="mt-1 break-all font-mono text-xs" title={checklist.llm.models[0] ?? provider.name}>
            {shortModelId(checklist.llm.models[0] ?? provider.name)}
          </div>
        </div>
      </div>
      {extracted.suspicious_text.length > 0 ? (
        <div className="mt-4 rounded-lg bg-blocked/10 p-3 text-xs text-blocked">
          <div className="flex items-center gap-1.5 font-medium">
            <ShieldAlert aria-hidden className="size-3.5" />
            Instruction-like text found in the PDF (ignored)
          </div>
          <ul className="mt-1.5 grid gap-1 font-mono">
            {extracted.suspicious_text.map((t) => (
              <li key={t} className="whitespace-pre-wrap break-words">
                “{t}”
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Card>
  )
}

interface DecisionCardProps extends PayoutActions {
  detail: InvoiceDetail
  payoutSeconds: number | null
  onRegister: () => void
  onApprove: (mode: ApproveMode) => void
  onSend: () => void
  onRetry: () => void
  onOverride: () => void
  onForce: () => void
  onDiscard: () => void
  busy: boolean
  executionLabel: string
}

type Tone = 'sage' | 'paused' | 'blocked' | 'dim'

const TONE_TEXT: Record<Tone, string> = { sage: 'text-sage', paused: 'text-paused', blocked: 'text-blocked', dim: 'text-dim' }

/** Decision on top: score ring, status heading, the one-line reason, the actions, "Why this score" and the AI analysis. */
function DecisionCard({ detail, payoutSeconds, onRegister, onApprove, onSend, onRetry, onOverride, onForce, onDiscard, onRetryPayout, onCheckPayout, busy, executionLabel }: DecisionCardProps) {
  const { invoice, checklist, beneficiary, payouts, provider, autoPay, decisionReason, scoreLines, executor } = detail
  const [why, setWhy] = useState(false)
  const failed = checklist.entries.some((e) => e.status === 'fail')
  const hold = invoice.status === 'approved' && invoice.hold === 1
  const overridden = invoice.override === 1
  const proposal = checklist.proposal
  const confirmed = payouts.find((p) => p.status === 'confirmed') ?? null
  const inFlight = payouts.find((p) => p.status === 'pending' || p.status === 'submitted') ?? null
  const lastFailed = payouts.find((p) => p.status === 'failed' || p.status === 'reverted') ?? null
  const hasError = !checklist.score && !checklist.entries.some((e) => e.status !== 'pending')
  const needsRegistration = !beneficiary || beneficiary.status !== 'active'

  function handleWhy() {
    setWhy((v) => !v)
  }
  function handleApproveHold() {
    onApprove('hold')
  }
  function handleApproveSend() {
    onApprove('send')
  }

  const rerunButton = (
    <Button variant="ghost" size="sm" className="text-dim" onClick={onRetry} disabled={busy} title="Investigate again from the stored PDF; the beneficiary stays">
      <RotateCcw aria-hidden />
      Re-run checks
    </Button>
  )

  let tone: Tone = 'dim'
  let icon: React.ReactNode = <Bot aria-hidden className="size-3.5" />
  let title = 'Waiting for the agent…'
  let body: React.ReactNode = null
  let actions: React.ReactNode = null
  let reason = decisionReason

  if (invoice.status === 'needs_approval') {
    tone = 'paused'
    icon = <ShieldAlert aria-hidden className="size-3.5" />
    title = 'Needs your approval'
    if (hasError) reason = 'The agent could not finish. Retry or review manually.'
    body =
      needsRegistration && proposal ? (
        <div className="mt-3 rounded-lg bg-raised p-3 text-xs">
          <div className="font-medium text-text">{proposal.name}</div>
          <div className="mt-0.5 text-dim">
            {proposal.country} · {proposal.type} · suggested limit <span className="font-mono text-text">{formatEur(proposal.suggested_limit_eur)}/mo</span>
          </div>
          {proposal.wallet ? (
            <div className="mt-1.5">
              <AddressMono value={proposal.wallet} />
            </div>
          ) : null}
        </div>
      ) : null
    actions = hasError ? (
      <Button variant="secondary" onClick={onRetry} disabled={busy}>
        <RotateCcw aria-hidden />
        Retry
      </Button>
    ) : needsRegistration && proposal ? (
      <>
        <Button onClick={onRegister} disabled={busy}>
          Register beneficiary + limit
        </Button>
        {rerunButton}
      </>
    ) : (
      <>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={handleApproveHold} disabled={busy} title="Approve now, release the payout later with Send">
            <Check aria-hidden />
            Approve
          </Button>
          <Button onClick={handleApproveSend} disabled={busy} title="Approve and queue the payout now">
            <Send aria-hidden />
            Approve &amp; send
          </Button>
        </div>
        {rerunButton}
      </>
    )
  } else if (invoice.status === 'rejected') {
    tone = 'blocked'
    icon = <ShieldAlert aria-hidden className="size-3.5" />
    title = 'Stopped · nothing moved'
    body = lastFailed ? (
      <div className="mt-3 rounded-lg bg-blocked/10 p-3 text-xs text-blocked">
        <div className="font-medium">{lastFailed.status === 'reverted' ? 'Forced anyway → chain reverted' : 'Forced anyway → payment rail refused'}</div>
        <div className="mt-1 break-words text-blocked/80">{lastFailed.error}</div>
        {lastFailed.tx_hash ? (
          <div className="mt-2">
            <AddressMono value={lastFailed.tx_hash} kind="tx" link={!lastFailed.simulated} /> {lastFailed.simulated ? '(simulated)' : ''}
          </div>
        ) : null}
      </div>
    ) : null
    actions = (
      <>
        {!inFlight ? (
          <Button variant="outline" className="border-blocked/40 text-blocked hover:bg-blocked/10 hover:text-blocked" onClick={onOverride} disabled={busy} title="Acknowledge every failed check, give a reason, pay the wallet on file">
            <ShieldAlert aria-hidden />
            Send anyway
          </Button>
        ) : null}
        {executor === 'simulated' && !lastFailed && !inFlight ? (
          <Button variant="ghost" size="sm" className="text-dim" onClick={onForce} disabled={busy} title="PAYMENT_EXECUTOR=simulated: try to pay the wallet printed on the PDF; the rail refuses">
            <Zap aria-hidden />
            Simulate a fooled agent (force)
          </Button>
        ) : null}
        {rerunButton}
      </>
    )
  } else if (hold) {
    tone = 'paused'
    icon = <Check aria-hidden className="size-3.5" />
    title = 'Approved · on hold'
    reason = `${beneficiary?.name ?? 'The payee'} is registered${beneficiary ? ` (limit ${formatEur(beneficiary.monthly_limit_eur)}/mo)` : ''}; nothing is sent until you click Send.`
    actions = (
      <>
        <Button onClick={onSend} disabled={busy} title="Queue the payout now (wallet on file, through Thyme)">
          <Send aria-hidden />
          Send
        </Button>
        {rerunButton}
      </>
    )
  } else if (invoice.status === 'approved' || invoice.status === 'paying') {
    tone = 'sage'
    icon = <LoaderCircle aria-hidden className="size-3.5 animate-spin" />
    title = invoice.status === 'approved' ? 'Payout queued' : 'Sending EURC'
    reason = executionLabel
    body = inFlight?.error ? <div className="mt-2 text-xs text-paused">{inFlight.error}</div> : null
    actions = (
      <div className="flex flex-wrap justify-end gap-1.5">
        {inFlight ? (
          <>
            <Button variant="ghost" size="sm" className="text-dim" onClick={() => onCheckPayout(inFlight.id)} disabled={busy} title="Re-read the Thyme execution by id">
              <RefreshCw aria-hidden />
              Check status
            </Button>
            <Button variant="ghost" size="sm" className="text-dim" onClick={() => onRetryPayout(inFlight.id)} disabled={busy} title="Re-arm with a new Idempotency-Key; refused while Thyme reports it running">
              <RotateCcw aria-hidden />
              Retry payout
            </Button>
          </>
        ) : null}
        <Button variant="ghost" size="sm" className="text-blocked hover:text-blocked" onClick={onDiscard} disabled={busy} title="Mark the payout and the invoice as failed">
          <X aria-hidden />
          Mark as failed
        </Button>
      </div>
    )
  } else if (invoice.status === 'paid' && confirmed) {
    tone = 'sage'
    icon = <Check aria-hidden className="size-3.5" />
    title = `Paid${confirmed.simulated ? ' · simulated (no chain transaction)' : ''}`
    body = (
      <div className="mt-2">
        <div className="font-mono text-2xl tracking-tightest">{formatEurc(confirmed.amount_eurc)} EURC</div>
        <div className="mt-1 text-xs text-dim">
          {payoutSeconds !== null ? `${payoutSeconds}s from upload to ${confirmed.simulated ? 'settlement' : 'block'}` : ''}
          {confirmed.amount_czk ? ` · ${confirmed.amount_czk.toLocaleString('cs-CZ', { maximumFractionDigits: 0 })} CZK at ČNB ${confirmed.cnb_rate}` : ''}
          {confirmed.gas_used ? ` · ${confirmed.gas_used.toLocaleString()} gas` : ''}
        </div>
      </div>
    )
    actions = (
      <>
        {confirmed.tx_hash ? <AddressMono value={confirmed.tx_hash} kind="tx" link={!confirmed.simulated} /> : null}
        <Button asChild variant="secondary" size="sm">
          <a href={`/api/reports/remittance/${confirmed.id}`} target="_blank" rel="noreferrer noopener">
            Remittance advice
            <ExternalLink aria-hidden />
          </a>
        </Button>
      </>
    )
  } else if (invoice.status === 'failed') {
    tone = 'blocked'
    icon = <TriangleAlert aria-hidden className="size-3.5" />
    title = 'Payment failed'
    reason = lastFailed?.error ?? payouts[0]?.error ?? 'See the payout row.'
    actions = (
      <>
        {lastFailed ? (
          <Button variant="secondary" onClick={() => onRetryPayout(lastFailed.id)} disabled={busy} title="Re-trigger Thyme with a new Idempotency-Key">
            <RotateCcw aria-hidden />
            Retry payout
          </Button>
        ) : null}
        {rerunButton}
      </>
    )
  }

  return (
    <Card className={cn('animate-rise', tone === 'blocked' && 'border border-blocked/30')}>
      <div className="flex items-start gap-5">
        <ScoreRing value={checklist.score} threshold={autoPay.threshold} failed={failed} />
        <div className="min-w-0 flex-1">
          <div className={cn('flex flex-wrap items-center gap-1.5 text-xs', TONE_TEXT[tone])}>
            {icon}
            <span>{title}</span>
            {overridden ? (
              <Chip tone="fail" className="ml-1 py-0.5" title="Paid by the owner despite failed checks (audit owner.override)">
                overridden
              </Chip>
            ) : null}
          </div>
          <p className="mt-1.5 text-sm leading-relaxed text-text">{reason ?? '—'}</p>
          <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-dim">
            <StatusPill status={invoice.status} />
            {hold ? <span>· on hold</span> : null}
            <span>· {autoPay.enabled ? `auto-pay ≥ ${autoPay.threshold}` : 'auto-pay off'}</span>
            <span>· {checklist.llm.calls} model call{checklist.llm.calls === 1 ? '' : 's'}</span>
            <span>· {formatUsd(checklist.llm.cost_usd)}</span>
          </div>
          {body}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">{actions}</div>
      </div>

      {scoreLines.length > 0 ? (
        <div className="mt-4 border-t border-hairline pt-2">
          <Button type="button" variant="ghost" size="sm" className="-ml-2 text-dim" onClick={handleWhy} aria-expanded={why}>
            <ChevronDown aria-hidden className={cn('transition-transform', why && 'rotate-180')} />
            Why this score
          </Button>
          {why ? (
            <ul className="mt-1 grid gap-1 pl-2 text-xs leading-relaxed text-secondary-foreground">
              {scoreLines.map((line, index) => (
                <li key={line} className={cn(index === 0 && 'text-text')}>
                  {line}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {invoice.decision_text ? (
        <div className="mt-4 border-t border-hairline pt-3">
          <p className="text-sm leading-relaxed text-secondary-foreground">{invoice.decision_text}</p>
          <div className="mt-2 flex items-center gap-1.5 text-xs text-dim">
            <Sparkles aria-hidden className="size-3" />
            You are reading an AI-generated analysis (Claude on Amazon Bedrock)
            {provider.name !== 'bedrock' ? <span>· this run: {provider.label}</span> : null}
          </div>
        </div>
      ) : null}
    </Card>
  )
}
