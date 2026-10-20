import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ArrowRight, Ban, FileText, LoaderCircle, Send, ShieldAlert, ShieldCheck, UserPlus } from 'lucide-react'
import type { ReactNode } from 'react'
import { toast } from 'sonner'
import { useAccount } from 'wagmi'
import { cn } from '@/lib/utils'
import { UploadButton } from '@/components/invoices/UploadButton'
import { PageHeader, Section } from '@/components/shell/Shell'
import { AddressMono } from '@/components/ui-kit/AddressMono'
import { BudgetBar } from '@/components/ui-kit/BudgetBar'
import { Chip, ChipLegend } from '@/components/ui-kit/Chip'
import { formatEur, formatTime } from '@/components/ui-kit/format'
import { Stat } from '@/components/ui-kit/Stat'
import { StatusDot } from '@/components/ui-kit/StatusDot'
import { Button } from '@/components/ui/button'
import { getDashboard } from '@/lib/server/dashboard.fns'
import type { ActivityItem, DashboardView } from '@/lib/server/dto'
import { sendHeldInvoice } from '@/lib/server/invoices.fns'
import { CHECK_DESCRIPTIONS } from '@/lib/agent/descriptions/checks'

const ICONS: Record<ActivityItem['kind'], typeof ArrowRight> = {
  paid: ArrowRight,
  blocked: Ban,
  held: ShieldCheck,
  rejected: Ban,
  registered: UserPlus,
  uploaded: FileText,
  info: FileText,
  overridden: ShieldAlert,
}

function num(s: string, dp = 2): string {
  const n = Number(s)
  return Number.isFinite(n) ? n.toLocaleString('en-IE', { minimumFractionDigits: dp, maximumFractionDigits: dp }) : s
}

export function DashboardPage({ initial }: { initial: DashboardView }) {
  const { address } = useAccount()
  const queryClient = useQueryClient()
  const { data } = useQuery({ queryKey: ['dashboard'], queryFn: () => getDashboard(), initialData: initial, refetchInterval: 5_000 })
  const view = data ?? initial
  const { counts, balances } = view
  const safe = view.safeAddress ?? address ?? null

  const send = useMutation({
    mutationFn: (invoiceId: string) => sendHeldInvoice({ data: { id: invoiceId } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['dashboard'] })
      await queryClient.invalidateQueries({ queryKey: ['invoices'] })
      await queryClient.invalidateQueries({ queryKey: ['payouts'] })
      toast.success('Payout queued', { description: 'Wallet on file, through the payment agent.' })
    },
    onError: (e) => toast.error(e.message),
  })

  function handleSend(event: React.MouseEvent<HTMLButtonElement>, invoiceId: string) {
    event.preventDefault()
    event.stopPropagation()
    send.mutate(invoiceId)
  }

  return (
    <>
      <PageHeader
        eyebrow={
          <span className="font-mono">
            {safe ? (
              <>
                Safe <AddressMono value={safe} />
              </>
            ) : (
              'Safe not enabled yet'
            )}
          </span>
        }
        title={
          <span className="font-mono text-5xl font-normal tracking-tightest">
            {balances ? `€${num(balances.eurc)}` : formatEur(counts.paidEur)}
            <span className="ml-3 text-base text-dim">{balances ? 'EURC in the Safe' : 'paid so far'}</span>
          </span>
        }
        actions={<UploadButton label="New invoice" icon="plus" variant="default" />}
      />
      {!view.onboarding.ready ? (
        <Banner tone="warn" action={<Button asChild size="sm"><Link to="/onboarding">Enable payroll</Link></Button>}>
          Payroll is not enabled on a Safe yet. Connect the owner wallet, pick the Safe and send one transaction; Thyme then pays EURC from it and can do nothing else.
          {!view.onboarding.configured ? ' (Thyme is not configured on this server: a labelled simulation is available.)' : ''}
        </Banner>
      ) : view.onboarding.simulated ? (
        <Banner tone="info" action={<Button asChild size="sm" variant="secondary"><Link to="/onboarding">Enable for real</Link></Button>}>
          Simulated onboarding: payouts are recorded with a labelled placeholder hash and never touch the chain.
        </Banner>
      ) : null}

      <div className="mt-6 flex flex-wrap gap-2.5">
        <TokenPill symbol="ETH" value={balances ? num(balances.eth, 4) : '—'} />
        <TokenPill symbol="EURC" value={balances ? num(balances.eurc) : '—'} />
        <TokenPill symbol="USDC" value={balances ? num(balances.usdc) : '—'} />
        {view.balancesError ? <span className="self-center text-xs text-dim">{view.balancesError}</span> : balances ? <span className="self-center text-xs text-dim">block {balances.blockNumber}</span> : null}
      </div>

      <div data-tour="dashboard-total" className="mt-8 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat
          label="Queue"
          value={counts.queued}
          hint={[counts.needsApproval ? `${counts.needsApproval} need approval` : null, counts.onHold ? `${counts.onHold} on hold` : null].filter(Boolean).join(' · ') || 'nothing waiting'}
        />
        <Stat label="Paid" value={counts.paid} hint={`${formatEur(counts.paidEur)} in EURC`} />
        <Stat label="Beneficiaries" value={counts.beneficiaries} hint={`${counts.activeBeneficiaries} active`} />
        <Stat label="Agents" value={`${counts.agentsRunning}/${counts.agentsTotal}`} hint={view.execution.mode === 'simulated' ? 'simulated payouts' : view.execution.mode} />
      </div>

      <Section title="Agents" aside={<ChipLegend />}>
        <div data-tour="dashboard-agents" className="grid gap-4 md:grid-cols-2">
          {view.agents.map((agent) => (
            <Link key={agent.id} to="/agents" className="block rounded-xl bg-surface p-5 transition-colors hover:bg-raised/60">
              <div className="flex items-center gap-2.5">
                <h3 className="text-base font-medium">{agent.name}</h3>
                <span className={cn('ml-auto inline-flex items-center gap-2 text-xs', agent.status === 'running' ? 'text-dim' : 'text-paused')}>
                  <StatusDot tone={agent.status === 'running' ? 'ok' : 'warn'} />
                  {agent.status}
                </span>
              </div>
              <div className="mt-1.5 text-xs text-dim capitalize">{agent.kind === 'payment' ? 'Pay' : 'Check'}</div>
              {agent.kind === 'payment' ? <BudgetBar used={agent.used_eur} limit={agent.limit_eur} className="mt-5" /> : <div className="mt-5 text-xs text-dim">{Object.keys(CHECK_DESCRIPTIONS).length} checks per invoice · auto-pay when every rule is green</div>}
              <div className="mt-4 flex flex-wrap gap-1.5">
                {agent.chips.map((c) => (
                  <Chip key={c.label} variant={c.variant}>
                    {c.label}
                  </Chip>
                ))}
              </div>
            </Link>
          ))}
        </div>
      </Section>

      {view.comparison ? (
        <Section title="This month vs SWIFT" aside={<Link to="/reports" className="text-xs text-dim hover:text-text">Sources ↗</Link>}>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Saved" value={formatEur(view.comparison.savedEur)} hint="fees vs SWIFT, non-SEPA corridors" />
            <Stat label="Business days saved" value={view.comparison.savedBusinessDays.toLocaleString('en-IE', { maximumFractionDigits: 1 })} hint="vs the realistic rail" />
            <Stat label="Payouts" value={view.comparison.payouts} hint={view.comparison.periodLabel} />
            <Stat label="Volume" value={formatEur(view.comparison.totalEur)} hint="EURC sent" />
          </div>
        </Section>
      ) : null}

      <Section title="Activity">
        {view.activity.length === 0 ? <div className="rounded-xl bg-surface p-5 text-xs text-dim">Nothing yet. Upload an invoice.</div> : null}
        <div data-tour="dashboard-activity" className="divide-y divide-hairline">
          {view.activity.map((item) => {
            const Icon = ICONS[item.kind]
            const red = item.kind === 'blocked' || item.kind === 'rejected' || item.kind === 'overridden'
            const sending = send.isPending && send.variables === item.invoice_id
            return (
              <div key={item.id} className={cn('grid grid-cols-[2rem_1fr_6rem_4rem_7rem] items-center gap-3 py-3.5 text-xs', red ? 'text-blocked' : 'text-text')}>
                <Icon aria-hidden className={cn('size-4', red ? 'text-blocked' : item.kind === 'held' ? 'text-paused' : 'text-sage/70')} strokeWidth={1.5} />
                <Link to="/invoices" search={item.invoice_id ? { id: item.invoice_id } : {}} className="truncate hover:text-sage">
                  {item.text}
                </Link>
                <span className="text-right font-mono">{item.amount_eur !== null && (item.kind === 'paid' || item.kind === 'blocked' || item.kind === 'rejected' || item.kind === 'overridden') ? `${item.kind === 'paid' ? '−' : ''}${formatEur(item.amount_eur)}` : ''}</span>
                <time className="text-right font-mono text-dim">{formatTime(item.ts)}</time>
                {item.hold && item.invoice_id ? (
                  <div className="flex justify-end">
                    <Button size="xs" onClick={(event) => handleSend(event, item.invoice_id as string)} disabled={sending} title="Release the payout now (wallet on file, through Thyme)">
                      {sending ? <LoaderCircle aria-hidden className="animate-spin" /> : <Send aria-hidden />}
                      Send
                    </Button>
                  </div>
                ) : (
                  <span className="text-right font-mono text-dim">{item.tx_hash ? `${item.tx_hash.slice(0, 6)}…${item.tx_hash.slice(-4)}${item.simulated ? ' sim' : ''}` : item.kind === 'blocked' ? 'reverted' : ''}</span>
                )}
              </div>
            )
          })}
        </div>
      </Section>
    </>
  )
}

function Banner({ tone, action, children }: { tone: 'warn' | 'info'; action: ReactNode; children: ReactNode }) {
  return (
    <div className={cn('mt-6 flex items-center justify-between gap-6 rounded-xl border bg-surface px-5 py-4 text-xs', tone === 'warn' ? 'border-paused/30' : 'border-hairline')}>
      <div className={cn(tone === 'warn' ? 'text-paused' : 'text-dim')}>{children}</div>
      <div className="shrink-0">{action}</div>
    </div>
  )
}

function TokenPill({ symbol, value }: { symbol: string; value: string }) {
  return (
    <div className="flex items-center gap-2.5 rounded-lg bg-surface px-3.5 py-2.5 text-xs">
      <span className="text-dim">{symbol}</span>
      <span className="font-mono">{value}</span>
    </div>
  )
}
