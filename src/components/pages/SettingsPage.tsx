import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useRouter } from '@tanstack/react-router'
import { LoaderCircle, RotateCcw } from 'lucide-react'
import { type FormEvent, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useAccount } from 'wagmi'
import { cn } from '@/lib/utils'
import { PageHeader, Section } from '@/components/shell/Shell'
import { AddressMono } from '@/components/ui-kit/AddressMono'
import { Chip } from '@/components/ui-kit/Chip'
import { RelativeTime } from '@/components/ui-kit/RelativeTime'
import { StatusDot } from '@/components/ui-kit/StatusDot'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { SettingsView } from '@/lib/server/dto'
import { getSettings, resetDemoData, updateSettings } from '@/lib/server/settings.fns'

const GROUPS: { id: SettingsView['env'][number]['group']; label: string }[] = [
  { id: 'llm', label: 'LLM' },
  { id: 'data', label: 'Data providers' },
  { id: 'thyme', label: 'Thyme Flow' },
  { id: 'chain', label: 'Chain' },
  { id: 'app', label: 'App' },
]

export function SettingsPage({ initial }: { initial: SettingsView }) {
  const queryClient = useQueryClient()
  const { address } = useAccount()
  const { data } = useQuery({ queryKey: ['settings'], queryFn: () => getSettings(), initialData: initial })
  const view = data ?? initial
  const [safe, setSafe] = useState(view.safeAddress ?? '')
  const [roles, setRoles] = useState(view.rolesProxy ?? '')
  const [roleKey, setRoleKey] = useState(view.roleKey ?? '')
  const [agent, setAgent] = useState(view.agentAddress ?? '')
  const save = useMutation({
    mutationFn: () => updateSettings({ data: { safeAddress: safe, rolesProxy: roles, roleKey, agentAddress: view.agentFromKey ? undefined : agent } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['settings'] })
      await queryClient.invalidateQueries({ queryKey: ['dashboard'] })
      toast.success('Settings saved')
    },
    onError: (e) => toast.error(e.message),
  })

  const router = useRouter()
  const [armed, setArmed] = useState(false)
  const reset = useMutation({
    mutationFn: () => resetDemoData(),
    onSuccess: async ({ removed }) => {
      setArmed(false)
      await queryClient.invalidateQueries()
      await router.invalidate()
      toast.success('Demo data reset', { description: `${removed.invoices} invoices, ${removed.payouts} payouts, ${removed.beneficiaries} beneficiaries removed` })
    },
    onError: (e) => toast.error(e.message),
  })
  useEffect(() => {
    if (!armed) return
    const timer = setTimeout(() => setArmed(false), 6000)
    return () => clearTimeout(timer)
  }, [armed])

  function handleSubmit(event: FormEvent) {
    event.preventDefault()
    save.mutate()
  }
  function handleReset() {
    if (!armed) {
      setArmed(true)
      return
    }
    reset.mutate()
  }
  function handleUseConnected() {
    if (address) setSafe(address)
  }

  return (
    <>
      <PageHeader title="Settings" eyebrow="Mandate, executor and environment" />

      <Section title="Mandate">
        <form onSubmit={handleSubmit} className="grid gap-4 rounded-xl bg-surface p-6">
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Safe address (owner = connected wallet)">
              <div className="flex gap-2">
                <Input value={safe} onChange={(e) => setSafe(e.target.value)} placeholder="0x…" className="font-mono text-xs" />
                {address ? (
                  <Button type="button" variant="secondary" onClick={handleUseConnected} title="Use the connected address (EOA demo)">
                    Use wallet
                  </Button>
                ) : null}
              </div>
            </Field>
            <Field label={view.agentFromKey ? 'Agent address (from AGENT_PRIVATE_KEY)' : 'Agent address (no key configured)'}>
              <Input value={agent} onChange={(e) => setAgent(e.target.value)} placeholder="0x…" className="font-mono text-xs" readOnly={view.agentFromKey} />
            </Field>
            <Field label="Roles proxy (set by the install tx)">
              <Input value={roles} onChange={(e) => setRoles(e.target.value)} placeholder="0x…" className="font-mono text-xs" />
            </Field>
            <Field label="Role key">
              <Input value={roleKey} onChange={(e) => setRoleKey(e.target.value)} placeholder="0x… (32 bytes)" className="font-mono text-xs" />
            </Field>
          </div>
          <div className="flex items-center justify-between">
            <div className="text-xs text-dim">
              {view.mandateId ? `mandate ${view.mandateId}` : 'no mandate installed'}
              {view.installTxHash ? (
                <>
                  {' '}
                  · install tx <AddressMono value={view.installTxHash} kind="tx" />
                </>
              ) : null}
            </div>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? <LoaderCircle aria-hidden className="animate-spin" /> : null}
              Save
            </Button>
          </div>
        </form>
      </Section>

      <Section title="Execution">
        <div className="grid gap-3 md:grid-cols-3">
          <Card label="Payment executor" value={view.executor} hint={view.execution.reason} tone={view.execution.mode === 'simulated' ? 'warn' : 'ok'} />
          <Card label="LLM provider" value={view.provider} hint={view.provider === 'mock' ? 'deterministic, no model call' : 'Haiku 4.5 extract · Sonnet 4.5 reason'} tone={view.provider === 'mock' ? 'warn' : 'ok'} />
          <Card label="Auto-pay threshold" value={String(view.autoPayThreshold)} hint="score required to pay without approval" tone="ok" />
        </div>
        <div className="mt-3 flex items-center gap-3 text-xs text-dim">
          <StatusDot tone={view.boot.running ? 'ok' : 'fail'} />
          worker {view.boot.running ? 'running' : 'stopped'} · started <RelativeTime iso={view.boot.startedAt} /> · last tick <RelativeTime iso={view.boot.lastTickAt} />
          {view.boot.lastError ? <span className="text-blocked">· {view.boot.lastError}</span> : null}
          <span>· db {view.databasePath}</span>
        </div>
      </Section>

      <Section title="Environment">
        <div className="grid gap-4 md:grid-cols-2">
          {GROUPS.map((g) => (
            <div key={g.id} className="rounded-xl bg-surface p-5">
              <h3 className="text-xs text-dim">{g.label}</h3>
              <dl className="mt-3 grid grid-cols-[1fr_auto] gap-x-4 gap-y-2 text-xs">
                {view.env
                  .filter((e) => e.group === g.id)
                  .map((e) => (
                    <div key={e.name} className="contents">
                      <dt className="flex items-center gap-2 font-mono">
                        <StatusDot tone={e.configured ? 'ok' : 'idle'} />
                        {e.name}
                      </dt>
                      <dd className={cn('font-mono', e.configured ? 'text-secondary-foreground' : 'text-dim')}>{e.masked}</dd>
                    </div>
                  ))}
              </dl>
            </div>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5">
          <Chip variant="agent">values never leave the server</Chip>
          <Chip variant="agent">secrets masked</Chip>
          <Chip variant="chain">Sepolia only</Chip>
        </div>
      </Section>

      <Section title="Demo data">
        <div className="flex items-center justify-between gap-6 rounded-xl bg-surface px-5 py-4">
          <div className="text-xs text-dim">
            Removes invoices, payouts, beneficiaries, the audit log and uploaded PDFs, and forgets the mandate. Keeps the Safe and agent addresses.
            {armed ? <span className="ml-1 text-blocked">Click again to confirm.</span> : null}
          </div>
          <Button
            type="button"
            variant="outline"
            className={cn('shrink-0', armed && 'border-blocked/40 text-blocked hover:bg-blocked/10 hover:text-blocked')}
            onClick={handleReset}
            disabled={reset.isPending}
          >
            {reset.isPending ? <LoaderCircle aria-hidden className="animate-spin" /> : <RotateCcw aria-hidden />}
            {armed ? 'Confirm reset' : 'Reset demo data'}
          </Button>
        </div>
      </Section>
    </>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="grid gap-1.5 text-xs text-dim">
      {label}
      {children}
    </label>
  )
}

function Card({ label, value, hint, tone }: { label: string; value: string; hint: string; tone: 'ok' | 'warn' }) {
  return (
    <div className="rounded-xl bg-surface px-5 py-4">
      <div className="text-xs text-dim">{label}</div>
      <div className={cn('mt-2 font-mono text-xl tracking-tightest', tone === 'warn' && 'text-paused')}>{value}</div>
      <div className="mt-1 text-xs text-dim">{hint}</div>
    </div>
  )
}
