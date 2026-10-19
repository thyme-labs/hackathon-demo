import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { LoaderCircle, Pause, Play, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { PageHeader, Section } from '@/components/shell/Shell'
import { AddressMono } from '@/components/ui-kit/AddressMono'
import { BudgetBar } from '@/components/ui-kit/BudgetBar'
import { Chip, ChipLegend } from '@/components/ui-kit/Chip'
import { formatEur, formatTime, formatUsd } from '@/components/ui-kit/format'
import { RelativeTime } from '@/components/ui-kit/RelativeTime'
import { StatusDot } from '@/components/ui-kit/StatusDot'
import { Button } from '@/components/ui/button'
import { listAgents, refreshThymeExecutable, toggleAgent } from '@/lib/server/agents.fns'
import type { AgentView } from '@/lib/server/dto'

export function AgentsPage({ initial }: { initial: AgentView[] }) {
  const { data } = useQuery({ queryKey: ['agents'], queryFn: () => listAgents(), initialData: initial, refetchInterval: 5_000 })
  const agents = data ?? initial
  return (
    <>
      <PageHeader title="Agents" eyebrow="Compliance checks the invoice; Payment hands approved payouts to Thyme Flow. Both can be paused." actions={<ChipLegend />} />
      <div className="mt-8 grid gap-4 lg:grid-cols-2">
        {agents.map((agent) => (
          <AgentCard key={agent.id} agent={agent} />
        ))}
      </div>
    </>
  )
}

function AgentCard({ agent }: { agent: AgentView }) {
  const queryClient = useQueryClient()
  const toggle = useMutation({
    mutationFn: () => toggleAgent({ data: { id: agent.id } }),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ['agents'] })
      await queryClient.invalidateQueries({ queryKey: ['dashboard'] })
      const description = result.thyme ? result.thyme.message : undefined
      if (result.thyme && !result.thyme.applied && agent.thyme.onboarded) toast.warning(`${agent.name} ${result.status} locally; Thyme not updated`, { description })
      else toast.message(result.status === 'paused' ? `${agent.name} paused` : `${agent.name} resumed`, { description })
    },
    onError: (e) => toast.error(e.message),
  })
  const refresh = useMutation({
    mutationFn: () => refreshThymeExecutable(),
    onSuccess: async (r) => {
      await queryClient.invalidateQueries({ queryKey: ['agents'] })
      toast.message(r.status ? `Executable ${r.status}${r.pausedReason ? ` · ${r.pausedReason}` : ''}` : 'No Thyme executable to read')
    },
    onError: (e) => toast.error(e.message),
  })
  const running = agent.status === 'running'
  const models = (agent.config.models as { extract?: string; reason?: string } | undefined) ?? {}
  const thyme = agent.thyme

  function handleToggle() {
    toggle.mutate()
  }
  function handleRefresh() {
    refresh.mutate()
  }

  return (
    <article className="rounded-xl bg-surface p-6">
      <div className="flex items-center gap-3">
        <h2 className="text-lg font-medium tracking-tightest">{agent.name}</h2>
        <Chip variant={agent.kind === 'payment' ? 'chain' : 'agent'}>{agent.kind === 'payment' ? 'Pay' : 'Check'}</Chip>
        <span className={cn('ml-auto inline-flex items-center gap-2 text-xs', running ? 'text-dim' : 'text-paused')}>
          <StatusDot tone={running ? 'ok' : 'warn'} pulse={running} />
          {agent.status}
        </span>
      </div>
      <div className="mt-1.5 text-xs text-dim">
        last run <RelativeTime iso={agent.last_run_at} />
      </div>

      {agent.kind === 'payment' ? (
        <BudgetBar used={agent.used_eur} limit={agent.limit_eur} className="mt-6" />
      ) : (
        <div className="mt-6 grid grid-cols-3 gap-3">
          <Mini label="Model calls" value={String(agent.llm_calls)} />
          <Mini label="Cost so far" value={formatUsd(agent.cost_usd)} />
          <Mini label="Auto-pay ≥" value={String(agent.config.auto_pay_threshold ?? 100)} />
        </div>
      )}

      <dl className="mt-5 grid grid-cols-[7rem_1fr] gap-y-2 text-xs">
        {agent.kind === 'compliance' ? (
          <>
            <dt className="text-dim">Provider</dt>
            <dd>{String(agent.config.provider ?? 'mock')}</dd>
            <dt className="text-dim">Extract</dt>
            <dd className="truncate font-mono" title={models.extract}>
              {models.extract ?? '—'}
            </dd>
            <dt className="text-dim">Reason</dt>
            <dd className="truncate font-mono" title={models.reason}>
              {models.reason ?? '—'}
            </dd>
            <dt className="text-dim">Checks</dt>
            <dd>12 per invoice · lists cached 24 h</dd>
          </>
        ) : (
          <>
            <dt className="text-dim">Executor</dt>
            <dd>
              Thyme Flow · <span className={agent.execution.mode === 'simulated' ? 'text-paused' : 'text-sage'}>{agent.execution.mode}</span>
            </dd>
            <dt className="text-dim">Why</dt>
            <dd className="text-dim">{agent.execution.reason}</dd>
            <dt className="text-dim">Safe</dt>
            <dd>{thyme.safeAddress ? <AddressMono value={thyme.safeAddress} /> : <span className="text-dim">not enabled</span>}</dd>
            <dt className="text-dim">Profile</dt>
            <dd className="truncate font-mono" title={thyme.profileId ?? undefined}>
              {thyme.profileId ? (
                <>
                  {thyme.profileId} <span className="text-dim">· {thyme.profileStatus ?? 'unknown'}</span>
                </>
              ) : (
                <span className="text-dim">none</span>
              )}
            </dd>
            <dt className="text-dim">Executable</dt>
            <dd className="flex items-center gap-2 truncate font-mono" title={thyme.executableId ?? undefined}>
              {thyme.executableId ? (
                <>
                  <span className="truncate">{thyme.executableId}</span>
                  <span className={cn('shrink-0', thyme.executableStatus === 'active' ? 'text-dim' : 'text-paused')}>· {thyme.executableStatus ?? 'unknown'}</span>
                  <button type="button" onClick={handleRefresh} aria-label="Refresh executable status" className="shrink-0 rounded-sm p-0.5 text-dim hover:text-text" disabled={refresh.isPending}>
                    <RefreshCw aria-hidden className={cn('size-3', refresh.isPending && 'animate-spin')} />
                  </button>
                </>
              ) : (
                <span className="text-dim">none</span>
              )}
            </dd>
            {thyme.executablePausedReason ? (
              <>
                <dt className="text-dim">Paused</dt>
                <dd className="break-words text-paused">{thyme.executablePausedReason}</dd>
              </>
            ) : null}
            <dt className="text-dim">Trigger</dt>
            <dd>{thyme.triggerMode === 'none' ? <span className="text-dim">none (simulated)</span> : thyme.triggerMode === 'webhook' ? 'webhook + cron every minute' : 'management run + cron every minute'}</dd>
            <dt className="text-dim">Last execution</dt>
            <dd className="truncate font-mono" title={thyme.lastExecutionId ?? undefined}>
              {thyme.lastExecutionId ?? <span className="text-dim">none yet</span>}
            </dd>
            <dt className="text-dim">Roles module</dt>
            <dd>{thyme.rolesProxy ? <AddressMono value={thyme.rolesProxy} /> : <span className="text-dim">none</span>}</dd>
            <dt className="text-dim">Payees</dt>
            <dd>
              {agent.payees} · {formatEur(agent.limit_eur)} / 30 d combined
            </dd>
          </>
        )}
      </dl>

      <div className="mt-5 flex flex-wrap gap-1.5">
        {agent.kind === 'payment' ? (
          <>
            <Chip variant="chain">EURC only</Chip>
            <Chip variant="chain">transfer only</Chip>
            <Chip variant="chain">this Safe via Thyme</Chip>
            <Chip variant="agent">{agent.payees} payee{agent.payees === 1 ? '' : 's'}</Chip>
            <Chip variant="agent">per-payee limit</Chip>
            <Chip variant="agent">invoice approved</Chip>
          </>
        ) : (
          <>
            <Chip variant="agent">sanctions</Chip>
            <Chip variant="agent">wallet on file</Chip>
            <Chip variant="agent">country risk</Chip>
            <Chip variant="agent">issuer backing</Chip>
            <Chip variant="agent">injection text</Chip>
          </>
        )}
      </div>

      <div className="mt-6 flex items-center justify-between gap-4">
        <Button variant={running ? 'outline' : 'default'} className={cn(running && 'border-blocked/40 text-blocked hover:bg-blocked/10 hover:text-blocked')} onClick={handleToggle} disabled={toggle.isPending}>
          {toggle.isPending ? <LoaderCircle aria-hidden className="animate-spin" /> : running ? <Pause aria-hidden /> : <Play aria-hidden />}
          {running ? 'Pause' : 'Resume'}
        </Button>
        {agent.kind === 'payment' ? (
          thyme.onboarded ? (
            <span className="text-xs text-dim">Pause also pauses the Thyme executable: cron and webhook runs refuse until resumed</span>
          ) : (
            <span className="text-xs text-dim">
              Pause stops the loop ·{' '}
              <Link to="/onboarding" className="hover:text-text">
                enable payroll on a Safe
              </Link>
            </span>
          )
        ) : null}
      </div>

      <Section title="Runs" className="mt-8">
        <div className="ml-1.5 border-l border-track">
          {agent.runs.length === 0 ? <div className="pl-6 text-xs text-dim">no runs yet</div> : null}
          {agent.runs.map((run) => {
            const blocked = run.event.includes('rejected') || run.event.includes('reverted') || run.event.includes('failed') || run.event.includes('refused')
            const held = run.event.includes('needs_approval') || run.event.includes('held') || run.event.includes('paused')
            return (
              <div key={run.id} className="relative pl-6 py-2">
                <span className={cn('absolute -left-1 top-3.5 size-1.5 rounded-full', blocked ? 'bg-blocked' : held ? 'bg-paused' : 'bg-dim')} />
                <Link to="/invoices" search={run.invoice_id ? { id: run.invoice_id } : {}} className={cn('grid grid-cols-[3.5rem_1fr] gap-3 text-xs hover:text-sage', blocked && 'text-blocked')}>
                  <time className="font-mono text-dim">{formatTime(run.ts)}</time>
                  <span className="truncate">{run.event}</span>
                </Link>
              </div>
            )
          })}
        </div>
      </Section>
    </article>
  )
}

function Mini({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-raised px-3 py-2.5">
      <div className="text-xs text-dim">{label}</div>
      <div className="mt-1 font-mono text-sm">{value}</div>
    </div>
  )
}
