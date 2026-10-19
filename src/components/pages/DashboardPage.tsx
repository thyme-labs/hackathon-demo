import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ArrowRight, Ban, FileText, Plus, ShieldCheck, UserPlus } from 'lucide-react'
import { useAccount } from 'wagmi'
import { cn } from '@/lib/utils'
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

const ICONS: Record<ActivityItem['kind'], typeof ArrowRight> = {
  paid: ArrowRight,
  blocked: Ban,
  held: ShieldCheck,
  rejected: Ban,
  registered: UserPlus,
  uploaded: FileText,
  info: FileText,
}

function num(s: string, dp = 2): string {
  const n = Number(s)
  return Number.isFinite(n) ? n.toLocaleString('en-IE', { minimumFractionDigits: dp, maximumFractionDigits: dp }) : s
}

export function DashboardPage({ initial }: { initial: DashboardView }) {
  const { address } = useAccount()
  const { data } = useQuery({ queryKey: ['dashboard'], queryFn: () => getDashboard(), initialData: initial, refetchInterval: 5_000 })
  const view = data ?? initial
  const { counts, balances } = view
  const safe = view.safeAddress ?? address ?? null

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
              'Safe not configured · Settings'
            )}
          </span>
        }
        title={
          <span className="font-mono text-5xl font-normal tracking-tightest">
            {balances ? `€${num(balances.eurc)}` : formatEur(counts.paidEur)}
            <span className="ml-3 text-base text-dim">{balances ? 'EURC in the Safe' : 'paid so far'}</span>
          </span>
        }
        actions={
          <Button asChild>
            <Link to="/invoices">
              <Plus aria-hidden />
              New invoice
            </Link>
          </Button>
        }
      />
      <div className="mt-6 flex flex-wrap gap-2.5">
        <TokenPill symbol="ETH" value={balances ? num(balances.eth, 4) : '—'} />
        <TokenPill symbol="EURC" value={balances ? num(balances.eurc) : '—'} />
        <TokenPill symbol="USDC" value={balances ? num(balances.usdc) : '—'} />
        {view.balancesError ? <span className="self-center text-xs text-dim">{view.balancesError}</span> : balances ? <span className="self-center text-xs text-dim">block {balances.blockNumber}</span> : null}
      </div>

      <div className="mt-8 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Queue" value={counts.queued} hint={counts.needsApproval ? `${counts.needsApproval} need approval` : 'nothing waiting'} />
        <Stat label="Paid" value={counts.paid} hint={`${formatEur(counts.paidEur)} in EURC`} />
        <Stat label="Beneficiaries" value={counts.beneficiaries} hint={`${counts.activeBeneficiaries} active`} />
        <Stat label="Agents" value={`${counts.agentsRunning}/${counts.agentsTotal}`} hint={view.execution.mode === 'simulated' ? 'simulated payouts' : view.execution.mode} />
      </div>

      <Section title="Agents" aside={<ChipLegend />}>
        <div className="grid gap-4 md:grid-cols-2">
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
              {agent.kind === 'payment' ? <BudgetBar used={agent.used_eur} limit={agent.limit_eur} className="mt-5" /> : <div className="mt-5 text-xs text-dim">12 checks per invoice · auto-pay when every rule is green</div>}
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
        <div className="divide-y divide-hairline">
          {view.activity.map((item) => {
            const Icon = ICONS[item.kind]
            const red = item.kind === 'blocked' || item.kind === 'rejected'
            return (
              <Link
                key={item.id}
                to="/invoices"
                search={item.invoice_id ? { id: item.invoice_id } : {}}
                className={cn('grid grid-cols-[2rem_1fr_6rem_4rem_7rem] items-center gap-3 py-4 text-xs', red ? 'text-blocked' : 'text-text')}
              >
                <Icon aria-hidden className={cn('size-4', red ? 'text-blocked' : 'text-sage/70')} strokeWidth={1.5} />
                <span className="truncate">{item.text}</span>
                <span className="text-right font-mono">{item.amount_eur !== null && (item.kind === 'paid' || item.kind === 'blocked' || item.kind === 'rejected') ? `${item.kind === 'paid' ? '−' : ''}${formatEur(item.amount_eur)}` : ''}</span>
                <time className="text-right font-mono text-dim">{formatTime(item.ts)}</time>
                <span className="text-right font-mono text-dim">{item.tx_hash ? `${item.tx_hash.slice(0, 6)}…${item.tx_hash.slice(-4)}${item.simulated ? ' sim' : ''}` : item.kind === 'blocked' ? 'reverted' : ''}</span>
              </Link>
            )
          })}
        </div>
      </Section>
    </>
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
