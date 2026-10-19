import { Bot, ExternalLink, LoaderCircle, ShieldAlert, Sparkles, TriangleAlert, Zap } from 'lucide-react'
import { AddressMono } from '@/components/ui-kit/AddressMono'
import { CheckItem } from '@/components/ui-kit/CheckItem'
import { Chip } from '@/components/ui-kit/Chip'
import { formatDateTime, formatEur, formatEurc, formatMoney, formatTime, formatUsd, secondsBetween } from '@/components/ui-kit/format'
import { ScoreRing } from '@/components/ui-kit/ScoreRing'
import { StatusPill } from '@/components/ui-kit/StatusPill'
import { Logo } from '@/components/shell/Logo'
import { Button } from '@/components/ui/button'
import type { InvoiceDetail } from '@/lib/server/dto'
import { cn } from '@/lib/utils'

interface InvestigationLogProps {
  detail: InvoiceDetail
  autoPayThreshold: number
  onRegister: () => void
  onApprove: () => void
  onRetry: () => void
  onForce: () => void
  busy: boolean
}

/** Chat-like investigation: upload bubble, extraction card, checks as they complete, score + decision, action card. */
export function InvestigationLog({ detail, autoPayThreshold, onRegister, onApprove, onRetry, onForce, busy }: InvestigationLogProps) {
  const { invoice, checklist, extracted, beneficiary, payouts, provider, executionMode, audit } = detail
  const fileName = uploadedName(audit) ?? invoice.file_path?.split('/').pop() ?? 'invoice.pdf'
  const running = invoice.status === 'queued' || invoice.status === 'investigating'
  const finished = Boolean(checklist.finished_at)
  const failed = checklist.entries.some((e) => e.status === 'fail')
  const payout = payouts[0] ?? null
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

      {extracted ? (
        <Card className="animate-rise">
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
              <div className="text-dim">Confidence · model</div>
              <div className="mt-1 font-mono">
                {Math.round(extracted.confidence * 100)}% · {checklist.llm.models[0] ?? provider.name}
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
                {extracted.suspicious_text.slice(0, 3).map((t) => (
                  <li key={t} className="truncate">
                    “{t}”
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </Card>
      ) : null}

      {checklist.entries.length > 0 ? (
        <Card className="mt-3">
          <div className="flex items-center justify-between">
            <div className="text-xs text-dim">Checks</div>
            {beneficiary ? (
              <div className="text-xs text-dim">
                matched <span className="text-text">{beneficiary.name}</span> · <StatusPill status={beneficiary.status} />
              </div>
            ) : finished ? (
              <div className="text-xs text-paused">new payee</div>
            ) : null}
          </div>
          <div className="mt-2">
            {checklist.entries.map((entry) => (
              <CheckItem key={entry.id} item={entry} />
            ))}
          </div>
        </Card>
      ) : null}

      {finished ? (
        <Card className="mt-3 animate-rise">
          <div className="flex items-center gap-6">
            <ScoreRing value={checklist.score} threshold={autoPayThreshold} failed={failed} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-xs text-dim">
                <StatusPill status={invoice.status} />
                <span>· threshold {autoPayThreshold}</span>
                <span>· {checklist.llm.calls} model call{checklist.llm.calls === 1 ? '' : 's'}</span>
                <span>· {formatUsd(checklist.llm.cost_usd)}</span>
              </div>
              <p className="mt-2 text-sm leading-relaxed">{invoice.decision_text ?? '—'}</p>
              <div className="mt-3 flex items-center gap-1.5 text-xs text-dim">
                <Sparkles aria-hidden className="size-3" />
                You are reading an AI-generated analysis (Claude on Amazon Bedrock)
                {provider.name !== 'bedrock' ? <span>· this run: {provider.label}</span> : null}
              </div>
            </div>
          </div>
        </Card>
      ) : null}

      {finished ? (
        <ActionCard
          detail={detail}
          payoutSeconds={paidSeconds}
          onRegister={onRegister}
          onApprove={onApprove}
          onRetry={onRetry}
          onForce={onForce}
          busy={busy}
          executionLabel={executionMode.mode === 'simulated' ? `simulated · ${executionMode.reason}` : executionMode.reason}
        />
      ) : null}

      {payouts.length > 0 ? (
        <Card className="mt-3">
          <div className="text-xs text-dim">Payouts</div>
          <div className="mt-2 grid gap-2">
            {payouts.map((p) => (
              <div key={p.id} className="grid grid-cols-[1fr_auto_auto] items-center gap-3 text-xs">
                <div className="flex items-center gap-2">
                  <StatusPill status={p.status} />
                  {p.simulated ? <Chip tone="warn">simulated</Chip> : null}
                  <span className="text-dim">{p.executor}</span>
                </div>
                <span className="font-mono">{formatEurc(p.amount_eurc)} EURC</span>
                {p.tx_hash ? <AddressMono value={p.tx_hash} kind="tx" link={!p.simulated} /> : <span className="text-dim">{formatTime(p.created_at)}</span>}
                {p.error ? <div className="col-span-3 text-blocked">{p.error}</div> : null}
              </div>
            ))}
          </div>
        </Card>
      ) : null}
    </div>
  )
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

interface ActionCardProps {
  detail: InvoiceDetail
  payoutSeconds: number | null
  onRegister: () => void
  onApprove: () => void
  onRetry: () => void
  onForce: () => void
  busy: boolean
  executionLabel: string
}

function ActionCard({ detail, payoutSeconds, onRegister, onApprove, onRetry, onForce, busy, executionLabel }: ActionCardProps) {
  const { invoice, checklist, beneficiary, payouts } = detail
  const payout = payouts.find((p) => p.status === 'confirmed') ?? payouts[0] ?? null
  const proposal = checklist.proposal

  if (invoice.status === 'needs_approval') {
    const needsRegistration = !beneficiary || beneficiary.status !== 'active'
    const hasError = !checklist.score && !checklist.entries.some((e) => e.status !== 'pending')
    return (
      <Card className="mt-3 animate-rise">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-xs text-paused">Needs your approval</div>
            {needsRegistration && proposal ? (
              <>
                <h3 className="mt-1 text-base font-medium">{proposal.name}</h3>
                <div className="mt-1 text-xs text-dim">
                  {proposal.country} · {proposal.type} · suggested limit <span className="font-mono text-text">{formatEur(proposal.suggested_limit_eur)}/mo</span>
                </div>
                {proposal.wallet ? (
                  <div className="mt-2">
                    <AddressMono value={proposal.wallet} />
                  </div>
                ) : null}
              </>
            ) : (
              <p className="mt-1 text-sm text-secondary-foreground">{hasError ? 'The agent could not finish. Retry or review manually.' : `Score below the auto-pay threshold. ${beneficiary ? `${beneficiary.name} is on file.` : ''}`}</p>
            )}
          </div>
          <div className="flex shrink-0 gap-2">
            {hasError ? (
              <Button variant="secondary" onClick={onRetry} disabled={busy}>
                Retry
              </Button>
            ) : null}
            {needsRegistration && proposal ? (
              <Button onClick={onRegister} disabled={busy}>
                Register beneficiary + limit
              </Button>
            ) : (
              <Button onClick={onApprove} disabled={busy || hasError}>
                Approve payout
              </Button>
            )}
          </div>
        </div>
      </Card>
    )
  }

  if (invoice.status === 'rejected') {
    const reverted = payouts.find((p) => p.status === 'reverted' || p.status === 'failed')
    return (
      <Card className="mt-3 animate-rise border border-blocked/30">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-1.5 text-xs text-blocked">
              <ShieldAlert aria-hidden className="size-3.5" />
              Stopped · nothing moved
            </div>
            <p className="mt-1 text-sm text-secondary-foreground">
              {checklist.entries
                .filter((e) => e.status === 'fail')
                .map((e) => e.label)
                .join(', ')}{' '}
              failed. The agent will not pay.
            </p>
            {reverted ? (
              <div className="mt-3 rounded-lg bg-blocked/10 p-3 text-xs text-blocked">
                <div className="font-medium">{reverted.status === 'reverted' ? 'Forced anyway → chain reverted' : 'Forced anyway → payment rail refused'}</div>
                <div className="mt-1 break-words text-blocked/80">{reverted.error}</div>
                {reverted.tx_hash ? (
                  <div className="mt-2">
                    <AddressMono value={reverted.tx_hash} kind="tx" link={!reverted.simulated} /> {reverted.simulated ? '(simulated)' : ''}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
          {!reverted ? (
            <Button variant="outline" className="shrink-0 border-blocked/40 text-blocked hover:bg-blocked/10 hover:text-blocked" onClick={onForce} disabled={busy}>
              <Zap aria-hidden />
              Force (what a fooled agent would do)
            </Button>
          ) : null}
        </div>
      </Card>
    )
  }

  if (invoice.status === 'approved' || invoice.status === 'paying') {
    return (
      <Card className="mt-3 animate-rise">
        <Row icon={<LoaderCircle aria-hidden className="size-4 animate-spin text-sage" />}>
          {invoice.status === 'approved' ? 'Payout queued' : 'Sending EURC'} · {executionLabel}
        </Row>
      </Card>
    )
  }

  if (invoice.status === 'paid' && payout) {
    return (
      <Card className="mt-3 animate-rise">
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="text-xs text-sage">Paid{payout.simulated ? ' · simulated (no chain transaction)' : ''}</div>
            <div className="mt-1 font-mono text-2xl tracking-tightest">{formatEurc(payout.amount_eurc)} EURC</div>
            <div className="mt-1 text-xs text-dim">
              {payoutSeconds !== null ? `${payoutSeconds}s from upload to ${payout.simulated ? 'settlement' : 'block'}` : ''}
              {payout.amount_czk ? ` · ${payout.amount_czk.toLocaleString('cs-CZ', { maximumFractionDigits: 0 })} CZK at ČNB ${payout.cnb_rate}` : ''}
              {payout.gas_used ? ` · ${payout.gas_used.toLocaleString()} gas` : ''}
            </div>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-2">
            {payout.tx_hash ? <AddressMono value={payout.tx_hash} kind="tx" link={!payout.simulated} /> : null}
            <Button asChild variant="secondary" size="sm">
              <a href={`/api/reports/remittance/${payout.id}`} target="_blank" rel="noreferrer noopener">
                Remittance advice
                <ExternalLink aria-hidden />
              </a>
            </Button>
          </div>
        </div>
      </Card>
    )
  }

  if (invoice.status === 'failed') {
    return (
      <Card className="mt-3 animate-rise border border-blocked/30">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-1.5 text-xs text-blocked">
              <TriangleAlert aria-hidden className="size-3.5" />
              Payment failed
            </div>
            <p className="mt-1 text-sm text-secondary-foreground">{payout?.error ?? 'See the payout row.'}</p>
          </div>
          <Button variant="secondary" onClick={onRetry} disabled={busy}>
            Retry
          </Button>
        </div>
      </Card>
    )
  }

  return (
    <Card className="mt-3">
      <Row icon={<Bot aria-hidden className="size-4 text-dim" />}>Waiting for the agent…</Row>
    </Card>
  )
}
