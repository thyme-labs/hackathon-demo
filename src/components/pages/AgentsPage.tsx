import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ExternalLink, LoaderCircle, Pause, Play } from 'lucide-react'
import { toast } from 'sonner'
import { type Address, getAddress } from 'viem'
import { useAccount, usePublicClient, useWriteContract } from 'wagmi'
import { cn } from '@/lib/utils'
import { PageHeader, Section } from '@/components/shell/Shell'
import { AddressMono } from '@/components/ui-kit/AddressMono'
import { BudgetBar } from '@/components/ui-kit/BudgetBar'
import { Chip, ChipLegend } from '@/components/ui-kit/Chip'
import { formatEur, formatTime, formatUsd } from '@/components/ui-kit/format'
import { RelativeTime } from '@/components/ui-kit/RelativeTime'
import { StatusDot } from '@/components/ui-kit/StatusDot'
import { Button } from '@/components/ui/button'
import { buildExecTransactionCall } from '@/lib/chain/safe'
import { SEPOLIA_CHAIN_ID } from '@/lib/roles/constants'
import { listAgents, recordMembershipTx, toggleAgent } from '@/lib/server/agents.fns'
import type { AgentView } from '@/lib/server/dto'

export function AgentsPage({ initial }: { initial: AgentView[] }) {
  const { data } = useQuery({ queryKey: ['agents'], queryFn: () => listAgents(), initialData: initial, refetchInterval: 5_000 })
  const agents = data ?? initial
  return (
    <>
      <PageHeader title="Agents" eyebrow="Compliance checks the invoice; Payment moves the EURC. Both can be paused." actions={<ChipLegend />} />
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
  const { address, isConnected } = useAccount()
  const publicClient = usePublicClient()
  const { writeContractAsync } = useWriteContract()
  const toggle = useMutation({
    mutationFn: () => toggleAgent({ data: { id: agent.id } }),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ['agents'] })
      await queryClient.invalidateQueries({ queryKey: ['dashboard'] })
      toast.message(result.status === 'paused' ? `${agent.name} paused` : `${agent.name} resumed`)
      const plan = result.plan
      if (plan?.safeTx && plan.safeAddress && isConnected && address && publicClient) {
        try {
          const call = buildExecTransactionCall(getAddress(plan.safeAddress), address as Address, { to: plan.safeTx.to, value: BigInt(plan.safeTx.value), data: plan.safeTx.data, operation: plan.safeTx.operation })
          const hash = await writeContractAsync({ ...call, chainId: SEPOLIA_CHAIN_ID })
          await publicClient.waitForTransactionReceipt({ hash })
          await recordMembershipTx({ data: { member: result.status === 'running', txHash: hash } })
          toast.success(result.status === 'paused' ? 'Role membership revoked on chain' : 'Role membership restored on chain')
          await queryClient.invalidateQueries({ queryKey: ['agents'] })
        } catch (error) {
          toast.error(error instanceof Error ? error.message : String(error))
        }
      }
    },
    onError: (e) => toast.error(e.message),
  })
  const running = agent.status === 'running'
  const models = (agent.config.models as { extract?: string; reason?: string } | undefined) ?? {}

  function handleToggle() {
    toggle.mutate()
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
              {agent.executor} · <span className={agent.execution.mode === 'simulated' ? 'text-paused' : 'text-sage'}>{agent.execution.mode}</span>
            </dd>
            <dt className="text-dim">Why</dt>
            <dd className="text-dim">{agent.execution.reason}</dd>
            <dt className="text-dim">Agent key</dt>
            <dd>{agent.agentAddress ? <AddressMono value={agent.agentAddress} /> : <span className="text-dim">none</span>}</dd>
            <dt className="text-dim">Roles module</dt>
            <dd>{agent.rolesProxy ? <AddressMono value={agent.rolesProxy} /> : <span className="text-dim">not installed</span>}</dd>
            <dt className="text-dim">Thyme Flow</dt>
            <dd className="flex items-center gap-2">
              {agent.thyme.triggerMode === 'none' ? <span className="text-dim">not configured</span> : agent.thyme.triggerMode}
              {agent.thyme.executableId ? (
                <a href={agent.thyme.consoleUrl ?? '#'} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 font-mono text-dim hover:text-text">
                  {agent.thyme.executableId.slice(0, 12)}…
                  <ExternalLink aria-hidden className="size-3" />
                </a>
              ) : null}
            </dd>
            <dt className="text-dim">Payees</dt>
            <dd>
              {agent.payees} · {formatEur(agent.limit_eur)} / mo combined
            </dd>
          </>
        )}
      </dl>

      <div className="mt-5 flex flex-wrap gap-1.5">
        {agent.kind === 'payment' ? (
          <>
            <Chip variant="chain">{agent.payees} payee{agent.payees === 1 ? '' : 's'}</Chip>
            <Chip variant="chain">per-payee limit</Chip>
            <Chip variant="chain">EURC only</Chip>
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

      <div className="mt-6 flex items-center justify-between">
        <Button variant={running ? 'outline' : 'default'} className={cn(running && 'border-blocked/40 text-blocked hover:bg-blocked/10 hover:text-blocked')} onClick={handleToggle} disabled={toggle.isPending}>
          {toggle.isPending ? <LoaderCircle aria-hidden className="animate-spin" /> : running ? <Pause aria-hidden /> : <Play aria-hidden />}
          {running ? 'Pause' : 'Resume'}
        </Button>
        {agent.kind === 'payment' ? <span className="text-xs text-dim">{agent.rolesProxy ? 'Pause also revokes the role on chain (1 tx)' : 'Pause stops the loop; no module installed yet'}</span> : null}
      </div>

      <Section title="Runs" className="mt-8">
        <div className="ml-1.5 border-l border-track">
          {agent.runs.length === 0 ? <div className="pl-6 text-xs text-dim">no runs yet</div> : null}
          {agent.runs.map((run) => {
            const blocked = run.event.includes('rejected') || run.event.includes('reverted') || run.event.includes('failed')
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
