import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useRouter } from '@tanstack/react-router'
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
import { Switch } from '@/components/ui/switch'
import type { SettingsView } from '@/lib/server/dto'
import { getSettings, resetDemoData, updateSettings } from '@/lib/server/settings.fns'
import { forgetThymeOnboarding } from '@/lib/server/thyme.fns'

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
  const thyme = view.thyme
  const [safe, setSafe] = useState(view.safeAddress ?? '')
  const save = useMutation({
    mutationFn: () => updateSettings({ data: { safeAddress: safe } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['settings'] })
      await queryClient.invalidateQueries({ queryKey: ['dashboard'] })
      toast.success('Settings saved')
    },
    onError: (e) => toast.error(e.message),
  })
  const [threshold, setThreshold] = useState(String(view.autoPayThreshold))
  const saveThreshold = useMutation({
    mutationFn: () => updateSettings({ data: { autoPayThreshold: Number(threshold) } }),
    onSuccess: async ({ autoPay }) => {
      setThreshold(String(autoPay.threshold))
      await queryClient.invalidateQueries({ queryKey: ['settings'] })
      await queryClient.invalidateQueries({ queryKey: ['dashboard'] })
      await queryClient.invalidateQueries({ queryKey: ['agents'] })
      toast.success(`Auto-pay threshold saved · ${autoPay.threshold}`, { description: 'Applies from the next investigation on.' })
    },
    onError: (e) => toast.error(e.message),
  })
  const toggleAutoPay = useMutation({
    mutationFn: (enabled: boolean) => updateSettings({ data: { autoPayEnabled: enabled } }),
    onSuccess: async ({ autoPay }) => {
      await queryClient.invalidateQueries({ queryKey: ['settings'] })
      await queryClient.invalidateQueries({ queryKey: ['dashboard'] })
      await queryClient.invalidateQueries({ queryKey: ['agents'] })
      toast.message(autoPay.enabled ? 'Auto-pay on' : 'Auto-pay off', { description: autoPay.enabled ? `Clean invoices of active payees scoring ≥ ${autoPay.threshold} are paid without you.` : 'Every invoice now waits for your approval.' })
    },
    onError: (e) => toast.error(e.message),
  })
  const forget = useMutation({
    mutationFn: () => forgetThymeOnboarding(),
    onSuccess: async () => {
      await queryClient.invalidateQueries()
      toast.message('Thyme onboarding forgotten')
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
  function handleForget() {
    forget.mutate()
  }
  function handleThresholdSubmit(event: FormEvent) {
    event.preventDefault()
    const n = Number(threshold)
    if (!Number.isFinite(n) || n < 0 || n > 100) {
      toast.error('Enter a number between 0 and 100')
      return
    }
    saveThreshold.mutate()
  }
  function handleThresholdChange(event: FormEvent<HTMLInputElement>) {
    setThreshold((event.target as HTMLInputElement).value)
  }
  function handleAutoPayToggle(checked: boolean) {
    toggleAutoPay.mutate(checked)
  }
  const thresholdDirty = threshold !== String(view.autoPayThreshold)

  const profileTone = thyme.profileStatus === 'active' ? 'ok' : thyme.profileStatus === 'failed' ? 'fail' : thyme.profileStatus === 'pending' ? 'warn' : 'idle'
  const executableTone = thyme.executableStatus === 'active' ? 'ok' : thyme.executableStatus === 'provisioning' ? 'warn' : thyme.executableId ? 'fail' : 'idle'

  return (
    <>
      <PageHeader title="Settings" eyebrow="Safe, Thyme rail and environment" />

      <Section
        title="Safe & Thyme"
        aside={
          <Button asChild variant="secondary" size="sm">
            <Link to="/onboarding">{thyme.onboarded ? 'Onboarding details' : 'Enable payroll'}</Link>
          </Button>
        }
      >
        <form onSubmit={handleSubmit} className="grid gap-4 rounded-xl bg-surface p-6">
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Safe address (the EURC treasury on Sepolia)">
              <div className="flex gap-2">
                <Input value={safe} onChange={(e) => setSafe(e.target.value)} placeholder="0x…" className="font-mono text-xs" readOnly={thyme.profileStatus === 'active'} />
                {address && thyme.profileStatus !== 'active' ? (
                  <Button type="button" variant="secondary" onClick={handleUseConnected} title="Use the connected address (EOA demo: balances only)">
                    Use wallet
                  </Button>
                ) : null}
              </div>
            </Field>
            <Field label="Owner wallet (sent the setup transaction)">
              <div className="flex h-9 items-center text-xs">{thyme.ownerAddress ? <AddressMono value={thyme.ownerAddress} /> : <span className="text-dim">none yet</span>}</div>
            </Field>
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            <Card label="Roles profile" value={thyme.profileStatus ?? (thyme.simulated ? 'simulated' : 'none')} hint={thyme.profileId ?? 'prepared by Thyme for your Safe'} tone={profileTone} mono />
            <Card label="Executable" value={thyme.executableStatus ?? (thyme.executableId ? 'unknown' : 'none')} hint={thyme.executablePausedReason ?? thyme.executableId ?? 'pay-invoice · cron every minute'} tone={executableTone} mono />
            <Card label="Webhook" value={thyme.hasWebhook ? 'ready' : 'none'} hint={thyme.hasWebhook ? 'run-only URL stored server-side' : 'created with the executable'} tone={thyme.hasWebhook ? 'ok' : 'idle'} />
          </div>
          <div className="flex items-center justify-between gap-4">
            <div className="text-xs text-dim">
              {thyme.setupTxHash ? (
                <>
                  setup tx <AddressMono value={thyme.setupTxHash} kind="tx" />
                  {' · '}
                </>
              ) : null}
              {thyme.rolesProxy ? (
                <>
                  Roles module <AddressMono value={thyme.rolesProxy} />
                </>
              ) : (
                'no Roles module yet'
              )}
              {thyme.lastExecutionId ? <span className="ml-2 font-mono">· last execution {thyme.lastExecutionId}</span> : null}
            </div>
            <div className="flex gap-2">
              {thyme.profileId || thyme.simulatedAt ? (
                <Button type="button" variant="ghost" className="text-dim" onClick={handleForget} disabled={forget.isPending}>
                  {forget.isPending ? <LoaderCircle aria-hidden className="animate-spin" /> : null}
                  Forget onboarding
                </Button>
              ) : null}
              <Button type="submit" disabled={save.isPending || thyme.profileStatus === 'active'}>
                {save.isPending ? <LoaderCircle aria-hidden className="animate-spin" /> : null}
                Save
              </Button>
            </div>
          </div>
        </form>
      </Section>

      <Section title="Auto-pay">
        <div data-tour="settings-autopay" className="grid gap-4 rounded-xl bg-surface p-6 md:grid-cols-[1fr_auto]">
          <form onSubmit={handleThresholdSubmit} className="grid gap-3">
            <Field label="Auto-pay threshold (score 0–100 an invoice needs to be paid without your approval)">
              <div className="flex gap-2">
                <Input type="number" min={0} max={100} step={1} value={threshold} onChange={handleThresholdChange} className="w-28 font-mono" aria-label="Auto-pay threshold" disabled={!view.autoPayEnabled} />
                <Button type="submit" disabled={saveThreshold.isPending || !thresholdDirty || !view.autoPayEnabled}>
                  {saveThreshold.isPending ? <LoaderCircle aria-hidden className="animate-spin" /> : null}
                  Save
                </Button>
              </div>
            </Field>
            <div className="text-xs text-dim">
              Only an active payee with trust ≥ 60 and no failed check can be paid automatically; below the threshold the invoice waits for you.
              {' · '}
              <span className="font-mono">{view.autoPaySource === 'settings' ? 'from settings' : 'from AUTO_PAY_THRESHOLD'}</span>
            </div>
          </form>
          <label className="flex items-start gap-3 rounded-lg bg-raised px-4 py-3 text-xs">
            <Switch checked={view.autoPayEnabled} onCheckedChange={handleAutoPayToggle} disabled={toggleAutoPay.isPending} aria-label="Auto-pay" className="mt-0.5" />
            <span className="grid gap-1">
              <span className={cn('font-medium', view.autoPayEnabled ? 'text-sage' : 'text-paused')}>{view.autoPayEnabled ? `Auto-pay on · ≥ ${view.autoPayThreshold}` : 'Auto-pay off'}</span>
              <span className="text-dim">{view.autoPayEnabled ? 'Clean invoices of active payees are paid without a click.' : 'Every invoice is held for your approval, whatever it scores.'}</span>
            </span>
          </label>
        </div>
      </Section>

      <Section title="Execution">
        <div className="grid gap-3 md:grid-cols-3">
          <Card label="Payment executor" value={view.executor} hint={view.execution.reason} tone={view.execution.mode === 'simulated' ? 'warn' : 'ok'} />
          <Card label="LLM provider" value={view.provider} hint={view.provider === 'mock' ? 'deterministic, no model call' : 'Haiku 4.5 extract · Sonnet 4.5 reason'} tone={view.provider === 'mock' ? 'warn' : 'ok'} />
          <Card label="Auto-pay" value={view.autoPayEnabled ? `≥ ${view.autoPayThreshold}` : 'off'} hint={view.autoPayEnabled ? 'score required to pay without approval' : 'every invoice waits for the owner'} tone={view.autoPayEnabled ? 'ok' : 'warn'} />
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
          <Chip variant="agent">no private key anywhere</Chip>
          <Chip variant="chain">Sepolia only</Chip>
        </div>
      </Section>

      <Section title="Demo data">
        <div className="flex items-center justify-between gap-6 rounded-xl bg-surface px-5 py-4">
          <div className="text-xs text-dim">
            Removes invoices, payouts, beneficiaries, the audit log and uploaded PDFs. Keeps the Safe address and the Thyme onboarding.
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

function Card({ label, value, hint, tone, mono = false }: { label: string; value: string; hint: string; tone: 'ok' | 'warn' | 'fail' | 'idle'; mono?: boolean }) {
  return (
    <div className="rounded-xl bg-surface px-5 py-4">
      <div className="text-xs text-dim">{label}</div>
      <div className={cn('mt-2 font-mono text-xl tracking-tightest', tone === 'warn' && 'text-paused', tone === 'fail' && 'text-blocked', tone === 'idle' && 'text-dim')}>{value}</div>
      <div className={cn('mt-1 truncate text-xs text-dim', mono && 'font-mono')} title={hint}>
        {hint}
      </div>
    </div>
  )
}
