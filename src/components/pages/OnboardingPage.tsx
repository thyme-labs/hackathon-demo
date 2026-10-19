import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useModal } from 'connectkit'
import { Check, ExternalLink, LoaderCircle, RotateCcw, X } from 'lucide-react'
import { type FormEvent, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { type Address, getAddress, type Hex, isAddress } from 'viem'
import { useAccount, usePublicClient, useSendTransaction, useSwitchChain } from 'wagmi'
import { cn } from '@/lib/utils'
import { PageHeader, Section } from '@/components/shell/Shell'
import { AddressMono } from '@/components/ui-kit/AddressMono'
import { Chip, ChipLegend } from '@/components/ui-kit/Chip'
import { RelativeTime } from '@/components/ui-kit/RelativeTime'
import { StatusDot } from '@/components/ui-kit/StatusDot'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { discoverSafes, getSafeInfo, type SafeInfo, type SafeSummary } from '@/lib/chain/safe'
import { SEPOLIA_CHAIN_ID } from '@/lib/roles/constants'
import type { ExecutableResult, PrepareProfileResult, ThymeOnboardingView } from '@/lib/server/dto'
import { confirmThymeSetup, ensureThymeExecutable, forgetThymeOnboarding, getThymeOnboarding, prepareThymeProfile, simulateThymeOnboarding } from '@/lib/server/thyme.fns'
import { etherscanAddress, etherscanTx } from '@/lib/wallet/wagmi'

type Phase = 'idle' | 'checking' | 'preparing' | 'sending' | 'mining' | 'confirming' | 'provisioning'

const CONFIRM_ATTEMPTS = 20
const CONFIRM_INTERVAL_MS = 4_000
const PROVISION_ATTEMPTS = 40
const PROVISION_INTERVAL_MS = 3_000

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function eligibility(info: SafeInfo, owner: Address | undefined): { ok: boolean; reason: string } {
  if (!info.isDeployed) return { ok: false, reason: 'No contract at this address on Sepolia' }
  if (!(info.version ?? '').startsWith('1.4') && !(info.version ?? '').startsWith('1.5')) return { ok: false, reason: `Safe ${info.version ?? '?'}: Thyme needs 1.4.1 or 1.5.0` }
  if (info.threshold !== 1) return { ok: false, reason: `Threshold ${info.threshold}: the owner must be able to execute alone (1/1)` }
  if (owner && !info.owners.some((o) => o.toLowerCase() === owner.toLowerCase())) return { ok: false, reason: 'The connected wallet is not an owner of this Safe' }
  return { ok: true, reason: `Safe ${info.version} · ${info.owners.length} owner${info.owners.length === 1 ? '' : 's'} · threshold ${info.threshold}${info.modules.length ? ` · ${info.modules.length} module${info.modules.length === 1 ? '' : 's'}` : ''}` }
}

/** Connect wallet -> Safe -> Thyme Roles profile (one owner transaction) -> executable + webhook. */
export function OnboardingPage({ initial }: { initial: ThymeOnboardingView }) {
  const queryClient = useQueryClient()
  const { address, isConnected, chainId } = useAccount()
  const { setOpen } = useModal()
  const publicClient = usePublicClient()
  const { sendTransactionAsync } = useSendTransaction()
  const { switchChainAsync } = useSwitchChain()
  const { data } = useQuery({ queryKey: ['thyme-onboarding'], queryFn: () => getThymeOnboarding(), initialData: initial, refetchInterval: 6_000 })
  const view = data ?? initial

  const [phase, setPhase] = useState<Phase>('idle')
  const [error, setError] = useState<string | null>(null)
  const [safeInput, setSafeInput] = useState(view.safeAddress ?? '')
  const [safeInfo, setSafeInfo] = useState<SafeInfo | null>(null)
  const [discovered, setDiscovered] = useState<SafeSummary[]>([])
  const [discoveryNote, setDiscoveryNote] = useState<string | null>(null)
  const [prepared, setPrepared] = useState<PrepareProfileResult | null>(null)
  const [txHash, setTxHash] = useState<Hex | null>(view.setupTxHash as Hex | null)
  const [executable, setExecutable] = useState<ExecutableResult | null>(null)

  const busy = phase !== 'idle'
  const safeValid = isAddress(safeInput)
  const owner = address as Address | undefined

  async function invalidate() {
    await queryClient.invalidateQueries({ queryKey: ['thyme-onboarding'] })
    await queryClient.invalidateQueries({ queryKey: ['dashboard'] })
    await queryClient.invalidateQueries({ queryKey: ['settings'] })
    await queryClient.invalidateQueries({ queryKey: ['agents'] })
  }

  // Discover the owner's Safes once a wallet is connected (Safe transaction service, keyless).
  useEffect(() => {
    if (!owner) return
    let cancelled = false
    discoverSafes(owner)
      .then((result) => {
        if (cancelled) return
        setDiscovered(result.safes.filter((s) => s.threshold === 1))
        setDiscoveryNote(result.source === 'unavailable' ? `Safe directory unavailable (${result.error ?? 'offline'}); paste the address instead.` : result.safes.length === 0 ? 'No Safe found for this wallet; paste one or create it in Safe{Wallet}.' : null)
      })
      .catch(() => {
        if (!cancelled) setDiscoveryNote('Safe directory unavailable; paste the address instead.')
      })
    return () => {
      cancelled = true
    }
  }, [owner])

  // Verify the chosen Safe on chain whenever the address changes.
  useEffect(() => {
    if (!safeValid || !publicClient) {
      setSafeInfo(null)
      return
    }
    let cancelled = false
    setPhase((p) => (p === 'idle' ? 'checking' : p))
    getSafeInfo(publicClient, getAddress(safeInput))
      .then((info) => {
        if (!cancelled) setSafeInfo(info)
      })
      .catch((e: unknown) => {
        if (!cancelled) setDiscoveryNote(`Could not read the Safe: ${describe(e)}`)
      })
      .finally(() => {
        if (!cancelled) setPhase((p) => (p === 'checking' ? 'idle' : p))
      })
    return () => {
      cancelled = true
    }
  }, [safeInput, safeValid, publicClient])

  const eligible = safeInfo ? eligibility(safeInfo, owner) : null

  const simulate = useMutation({
    mutationFn: () => simulateThymeOnboarding({ data: { safeAddress: safeValid ? getAddress(safeInput) : null } }),
    onSuccess: async () => {
      await invalidate()
      toast.message('Onboarding simulated', { description: 'No wallet, no Thyme: payouts will be labelled simulated.' })
    },
    onError: (e) => toast.error(e.message),
  })
  const forget = useMutation({
    mutationFn: () => forgetThymeOnboarding(),
    onSuccess: async () => {
      setPrepared(null)
      setTxHash(null)
      setExecutable(null)
      setError(null)
      await invalidate()
      toast.message('Onboarding forgotten', { description: 'The profile and executable stay at Thyme; this app no longer uses them.' })
    },
    onError: (e) => toast.error(e.message),
  })

  async function runEnsureExecutable(): Promise<void> {
    setPhase('provisioning')
    setError(null)
    try {
      for (let attempt = 0; attempt < PROVISION_ATTEMPTS; attempt++) {
        const result = await ensureThymeExecutable()
        setExecutable(result)
        if (result.ready) {
          toast.success('Payroll enabled', { description: 'Thyme executable active and reachable through its webhook.' })
          await invalidate()
          setPhase('idle')
          return
        }
        if (result.status === 'paused' || result.status === 'error' || result.status === 'deleted') {
          setError(result.message)
          await invalidate()
          setPhase('idle')
          return
        }
        await sleep(PROVISION_INTERVAL_MS)
      }
      setError('Thyme is still provisioning the sandbox. Try again in a minute.')
    } catch (e) {
      setError(describe(e))
    } finally {
      await invalidate()
      setPhase('idle')
    }
  }

  async function runConfirm(profileId: string, hash: Hex): Promise<void> {
    setPhase('confirming')
    setError(null)
    try {
      for (let attempt = 0; attempt < CONFIRM_ATTEMPTS; attempt++) {
        const result = await confirmThymeSetup({ data: { profileId, txHash: hash } })
        if (result.status === 'active') {
          toast.success('Roles profile active on the Safe')
          await invalidate()
          await runEnsureExecutable()
          return
        }
        await sleep(CONFIRM_INTERVAL_MS)
      }
      setError('Thyme has not seen the receipt yet. Click Confirm again in a moment.')
    } catch (e) {
      setError(describe(e))
    } finally {
      await invalidate()
      setPhase((p) => (p === 'confirming' ? 'idle' : p))
    }
  }

  async function handlePrepare(): Promise<void> {
    if (!owner || !safeValid) return
    setPhase('preparing')
    setError(null)
    try {
      const result = await prepareThymeProfile({ data: { safeAddress: getAddress(safeInput), ownerAddress: owner } })
      setPrepared(result)
      await invalidate()
    } catch (e) {
      setError(describe(e))
    } finally {
      setPhase('idle')
    }
  }

  async function handleSend(): Promise<void> {
    if (!prepared || !owner || !publicClient) return
    if (owner.toLowerCase() !== prepared.ownerAddress.toLowerCase()) {
      toast.error('Connect the Safe owner wallet that prepared this profile')
      return
    }
    setPhase('sending')
    setError(null)
    try {
      if (chainId !== SEPOLIA_CHAIN_ID) await switchChainAsync({ chainId: SEPOLIA_CHAIN_ID })
      const hash = await sendTransactionAsync({
        chainId: SEPOLIA_CHAIN_ID,
        to: prepared.transaction.to as Address,
        value: BigInt(prepared.transaction.value),
        data: prepared.transaction.data as Hex,
      })
      setTxHash(hash)
      setPhase('mining')
      toast.message('Transaction sent', { description: hash })
      const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 })
      if (receipt.status !== 'success') throw new Error('The setup transaction reverted; nothing was installed on the Safe')
      await runConfirm(prepared.profileId, hash)
    } catch (e) {
      setError(describe(e))
      setPhase('idle')
    }
  }

  async function handleConfirmAgain(): Promise<void> {
    if (!view.profileId || !txHash) return
    await runConfirm(view.profileId, txHash)
  }

  function handleConnect() {
    setOpen(true)
  }
  function handleSafeInput(event: FormEvent<HTMLInputElement>) {
    setSafeInput((event.target as HTMLInputElement).value.trim())
    setPrepared(null)
  }
  function handlePickSafe(safe: SafeSummary) {
    setSafeInput(safe.address)
    setPrepared(null)
  }
  function handleSimulate() {
    simulate.mutate()
  }
  function handleForget() {
    forget.mutate()
  }
  function handleEnsureExecutable() {
    void runEnsureExecutable()
  }
  function handlePrepareClick() {
    void handlePrepare()
  }
  function handleSendClick() {
    void handleSend()
  }
  function handleConfirmClick() {
    void handleConfirmAgain()
  }

  const stepDone = {
    connect: isConnected || view.onboarded || view.simulated,
    safe: Boolean(view.safeAddress) || (safeValid && Boolean(eligible?.ok)),
    profile: view.profileStatus === 'active',
    executable: view.onboarded,
  }
  const canPrepare = isConnected && safeValid && Boolean(eligible?.ok) && view.configured && !busy
  const scope = prepared?.scope ?? view.scope
  const allowlist = prepared?.scopeRules ?? view.allowlist

  return (
    <>
      <PageHeader
        title="Enable payroll on your Safe"
        eyebrow="One owner transaction. Thyme then pays EURC from the Safe and can do nothing else."
        actions={<ChipLegend />}
      />

      {!view.configured ? (
        <div className="mt-6 rounded-xl border border-paused/30 bg-surface p-5 text-xs">
          <div className="text-paused">Thyme is not configured on this server</div>
          <div className="mt-1 text-dim">
            Missing {view.missingEnv.join(', ')}. The real onboarding needs {view.missingEnv.length === 1 ? 'it' : 'them'}; the labelled simulation below still works.
          </div>
        </div>
      ) : null}

      {view.onboarded || view.simulated ? <DoneCard view={view} onForget={handleForget} forgetting={forget.isPending} /> : null}

      <Section title="Steps">
        <ol className="grid gap-3">
          {/* 1. Wallet */}
          <Step n={1} title="Connect the Safe owner wallet" done={stepDone.connect} active={!stepDone.connect}>
            {isConnected && address ? (
              <div className="flex items-center gap-3 text-xs">
                <AddressMono value={address} />
                <span className="text-dim">{chainId === SEPOLIA_CHAIN_ID ? 'Sepolia' : 'switches to Sepolia when sending'}</span>
              </div>
            ) : (
              <div className="flex items-center gap-3">
                <Button onClick={handleConnect}>Connect wallet</Button>
                <span className="text-xs text-dim">MetaMask or any injected wallet; it must own a 1/1 Safe on Sepolia.</span>
              </div>
            )}
          </Step>

          {/* 2. Safe */}
          <Step n={2} title="Choose the Safe that holds the EURC" done={stepDone.safe && view.profileStatus === 'active'} active={stepDone.connect && view.profileStatus !== 'active'}>
            {discovered.length > 0 ? (
              <div className="mb-3 flex flex-wrap gap-1.5">
                {discovered.map((s) => (
                  <button
                    type="button"
                    key={s.address}
                    onClick={() => handlePickSafe(s)}
                    className={cn('rounded-md bg-raised px-2.5 py-1.5 font-mono text-xs transition-colors hover:text-text', safeInput.toLowerCase() === s.address.toLowerCase() ? 'text-text ring-1 ring-sage/50' : 'text-dim')}
                  >
                    {s.address.slice(0, 8)}…{s.address.slice(-4)} · v{s.version ?? '?'}
                  </button>
                ))}
              </div>
            ) : null}
            <div className="flex gap-2">
              <Input value={safeInput} onChange={handleSafeInput} placeholder="0x… Safe address on Sepolia" className="font-mono text-xs" readOnly={view.profileStatus === 'active'} />
            </div>
            <div className="mt-2 flex items-center gap-2 text-xs">
              {phase === 'checking' ? <LoaderCircle aria-hidden className="size-3 animate-spin text-dim" /> : null}
              {eligible ? (
                <>
                  <StatusDot tone={eligible.ok ? 'ok' : 'fail'} />
                  <span className={eligible.ok ? 'text-dim' : 'text-blocked'}>{eligible.reason}</span>
                </>
              ) : discoveryNote ? (
                <span className="text-dim">{discoveryNote}</span>
              ) : (
                <span className="text-dim">Paste a Safe address or pick one above. Thyme reads owners, threshold and version on chain.</span>
              )}
            </div>
          </Step>

          {/* 3. Profile */}
          <Step n={3} title="Enable payroll on this Safe" done={stepDone.profile} active={stepDone.safe && !stepDone.profile}>
            {!prepared && view.profileStatus !== 'active' ? (
              <div className="flex flex-wrap items-center gap-3">
                <Button onClick={handlePrepareClick} disabled={!canPrepare}>
                  {phase === 'preparing' ? <LoaderCircle aria-hidden className="animate-spin" /> : null}
                  {view.profileId ? 'Prepare again' : 'Prepare with Thyme'}
                </Button>
                <span className="text-xs text-dim">Thyme reads the Safe, derives the Roles module and returns one transaction for you to send.</span>
              </div>
            ) : null}

            {prepared && view.profileStatus !== 'active' ? (
              <div className="grid gap-4">
                <div className="grid grid-cols-2 gap-6">
                  <div>
                    <h4 className="mb-2 text-xs text-dim">Thyme can</h4>
                    {scope.can.map((line) => (
                      <div key={line} className="my-2 flex items-start gap-2 text-xs text-secondary-foreground">
                        <Check aria-hidden className="mt-0.5 size-3.5 shrink-0 text-sage" />
                        {line}
                      </div>
                    ))}
                  </div>
                  <div>
                    <h4 className="mb-2 text-xs text-dim">Thyme can’t</h4>
                    {scope.cant.map((line) => (
                      <div key={line} className="my-2 flex items-start gap-2 text-xs text-secondary-foreground">
                        <X aria-hidden className="mt-0.5 size-3.5 shrink-0 text-dim" />
                        {line}
                      </div>
                    ))}
                  </div>
                </div>
                <dl className="grid grid-cols-[8rem_1fr] gap-y-1.5 border-y border-hairline py-3 font-mono text-xs">
                  <dt className="text-dim">allowlist</dt>
                  <dd>
                    {allowlist.map((r) => (
                      <div key={`${r.target}${r.selector}`}>
                        {r.functionSignature ?? r.selector} on {r.target.slice(0, 8)}… (EURC)
                      </div>
                    ))}
                  </dd>
                  <dt className="text-dim">roles module</dt>
                  <dd>
                    <AddressMono value={prepared.predicted.rolesProxy} />
                  </dd>
                  <dt className="text-dim">executor safe</dt>
                  <dd>
                    <AddressMono value={prepared.predicted.executorSafe} />
                  </dd>
                  <dt className="text-dim">transaction to</dt>
                  <dd>
                    <AddressMono value={prepared.transaction.to} /> <span className="text-dim">(your Safe, value 0)</span>
                  </dd>
                  <dt className="text-dim">profile</dt>
                  <dd className="truncate">{prepared.profileId}</dd>
                </dl>
                <div className="flex flex-wrap items-center gap-3">
                  <Button onClick={handleSendClick} disabled={busy || !isConnected}>
                    {phase === 'sending' || phase === 'mining' || phase === 'confirming' ? <LoaderCircle aria-hidden className="animate-spin" /> : null}
                    {phase === 'sending' ? 'Confirm in wallet…' : phase === 'mining' ? 'Waiting for the receipt…' : phase === 'confirming' ? 'Thyme is verifying…' : 'Send with MetaMask'}
                  </Button>
                  {txHash ? <AddressMono value={txHash} kind="tx" /> : null}
                  <span className="text-xs text-dim">Plain EOA transaction from the owner; never through a Safe app or bundler.</span>
                </div>
              </div>
            ) : null}

            {!prepared && view.profileId && view.profileStatus === 'pending' && txHash ? (
              <div className="mt-3 flex flex-wrap items-center gap-3 text-xs">
                <span className="text-dim">
                  Setup tx <AddressMono value={txHash} kind="tx" /> sent; Thyme has not confirmed it yet.
                </span>
                <Button variant="secondary" size="sm" onClick={handleConfirmClick} disabled={busy}>
                  {phase === 'confirming' ? <LoaderCircle aria-hidden className="animate-spin" /> : null}
                  Confirm again
                </Button>
              </div>
            ) : null}

            {view.profileStatus === 'active' ? (
              <div className="grid gap-1.5 text-xs">
                <div className="flex items-center gap-2">
                  <StatusDot tone="ok" />
                  Roles profile active · <span className="font-mono text-dim">{view.profileId}</span>
                </div>
                {view.setupTxHash ? (
                  <div className="text-dim">
                    setup tx <AddressMono value={view.setupTxHash} kind="tx" />
                  </div>
                ) : null}
              </div>
            ) : null}
            {view.profileStatus === 'failed' && view.profileError ? <div className="mt-2 text-xs text-blocked">{view.profileError}</div> : null}
          </Step>

          {/* 4. Executable */}
          <Step n={4} title="Thyme executable + webhook" done={stepDone.executable} active={stepDone.profile && !stepDone.executable}>
            {view.onboarded ? (
              <div className="grid gap-1.5 text-xs">
                <div className="flex items-center gap-2">
                  <StatusDot tone="ok" />
                  executable <span className="font-mono text-dim">{view.executableId}</span> · {view.executableStatus ?? 'active'} · cron every minute + webhook
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-3">
                <Button onClick={handleEnsureExecutable} disabled={busy || view.profileStatus !== 'active'}>
                  {phase === 'provisioning' ? <LoaderCircle aria-hidden className="animate-spin" /> : null}
                  {view.executableId ? 'Check executable' : 'Create executable'}
                </Button>
                <span className="text-xs text-dim">
                  {executable ? `${executable.status}${executable.pausedReason ? ` · ${executable.pausedReason}` : ''} · ${executable.message}` : 'Creates the pay-invoice executable on the profile (sponsored gas) and a run-only webhook the payment agent triggers.'}
                </span>
              </div>
            )}
          </Step>
        </ol>
        {error ? <div className="mt-4 rounded-lg border border-blocked/30 bg-blocked/10 p-3 text-xs text-blocked break-words">{error}</div> : null}
      </Section>

      <Section title="No wallet at hand?">
        <div className="flex items-center justify-between gap-6 rounded-xl bg-surface px-5 py-4">
          <div className="text-xs text-dim">
            Demo without MetaMask or Thyme: every payout is recorded with a labelled placeholder hash and no Etherscan link. Nothing touches the chain.
            {view.simulated ? (
              <>
                {' '}
                Active since <RelativeTime iso={view.simulatedAt} />.
              </>
            ) : null}
          </div>
          <Button type="button" variant="outline" className="shrink-0" onClick={handleSimulate} disabled={simulate.isPending || view.onboarded}>
            {simulate.isPending ? <LoaderCircle aria-hidden className="animate-spin" /> : null}
            {view.simulated ? 'Simulated · refresh' : 'Simulate onboarding'}
          </Button>
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5">
          <Chip variant="chain">EURC only</Chip>
          <Chip variant="chain">transfer only</Chip>
          <Chip variant="chain">from this Safe via Thyme</Chip>
          <Chip variant="agent">per-beneficiary limit</Chip>
          <Chip variant="agent">wallet on file</Chip>
          <Chip variant="agent">sanctions, country, issuer</Chip>
        </div>
      </Section>
    </>
  )
}

function Step({ n, title, done, active, children }: { n: number; title: string; done: boolean; active: boolean; children: React.ReactNode }) {
  return (
    <li className={cn('rounded-xl bg-surface p-5', active && 'ring-1 ring-sage/30')}>
      <div className="flex items-center gap-3">
        <span className={cn('grid size-6 place-items-center rounded-full font-mono text-xs', done ? 'bg-sage text-sage-ink' : active ? 'bg-raised text-text' : 'bg-raised text-dim')}>{done ? <Check aria-hidden className="size-3.5" /> : n}</span>
        <h3 className={cn('text-sm font-medium', !done && !active && 'text-dim')}>{title}</h3>
      </div>
      <div className="mt-4 pl-9">{children}</div>
    </li>
  )
}

function DoneCard({ view, onForget, forgetting }: { view: ThymeOnboardingView; onForget: () => void; forgetting: boolean }) {
  return (
    <div className={cn('mt-6 rounded-xl bg-surface p-6', view.simulated && 'border border-paused/30')}>
      <div className="flex items-start justify-between gap-6">
        <div>
          <div className={cn('text-xs', view.simulated ? 'text-paused' : 'text-sage')}>{view.simulated ? 'Simulated onboarding · payouts are labelled simulated' : 'Payroll enabled · Thyme pays EURC from this Safe'}</div>
          <dl className="mt-3 grid grid-cols-[8rem_1fr] gap-y-1.5 text-xs">
            <dt className="text-dim">Safe</dt>
            <dd>
              {view.safeAddress ? (
                <a href={etherscanAddress(view.safeAddress)} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 font-mono hover:text-sage">
                  {view.safeAddress}
                  <ExternalLink aria-hidden className="size-3" />
                </a>
              ) : (
                <span className="text-dim">none (simulation)</span>
              )}
            </dd>
            {view.setupTxHash ? (
              <>
                <dt className="text-dim">Setup tx</dt>
                <dd>
                  <a href={etherscanTx(view.setupTxHash)} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 font-mono hover:text-sage">
                    {view.setupTxHash.slice(0, 18)}…
                    <ExternalLink aria-hidden className="size-3" />
                  </a>
                </dd>
              </>
            ) : null}
            {view.rolesProxy ? (
              <>
                <dt className="text-dim">Roles module</dt>
                <dd>
                  <AddressMono value={view.rolesProxy} />
                </dd>
              </>
            ) : null}
            {view.profileId ? (
              <>
                <dt className="text-dim">Thyme profile</dt>
                <dd className="font-mono">{view.profileId}</dd>
              </>
            ) : null}
            {view.executableId ? (
              <>
                <dt className="text-dim">Executable</dt>
                <dd className="font-mono">
                  {view.executableId} <span className="text-dim">· {view.executableStatus ?? 'active'} · webhook {view.hasWebhook ? 'ready' : 'missing'}</span>
                </dd>
              </>
            ) : null}
          </dl>
          <div className="mt-4 flex flex-wrap gap-1.5">
            <Chip variant="chain">EURC only</Chip>
            <Chip variant="chain">transfer only</Chip>
            <Chip variant="chain">this Safe via Thyme</Chip>
            <Chip variant="agent">per-beneficiary limit</Chip>
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          <Button asChild variant="secondary" size="sm">
            <Link to="/invoices">Go to invoices</Link>
          </Button>
          <Button variant="ghost" size="sm" className="text-dim" onClick={onForget} disabled={forgetting}>
            {forgetting ? <LoaderCircle aria-hidden className="animate-spin" /> : <RotateCcw aria-hidden />}
            Forget onboarding
          </Button>
        </div>
      </div>
    </div>
  )
}
