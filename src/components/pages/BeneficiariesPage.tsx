import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Ban, Plus, ShieldCheck, ShieldOff, Star } from 'lucide-react'
import { type FormEvent, useState } from 'react'
import { toast } from 'sonner'
import { PageHeader } from '@/components/shell/Shell'
import { AddressMono } from '@/components/ui-kit/AddressMono'
import { CheckItem } from '@/components/ui-kit/CheckItem'
import { Chip } from '@/components/ui-kit/Chip'
import { formatDate, formatEur, formatEurc, formatMoney } from '@/components/ui-kit/format'
import { RelativeTime } from '@/components/ui-kit/RelativeTime'
import { ScoreRing } from '@/components/ui-kit/ScoreRing'
import { StatusPill } from '@/components/ui-kit/StatusPill'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import {
  addBeneficiaryWallet,
  approveBeneficiaryWallet,
  getBeneficiary,
  listBeneficiaries,
  revokeBeneficiaryWallet,
  setBeneficiaryStatus,
  setPrimaryBeneficiaryWallet,
} from '@/lib/server/beneficiaries.fns'
import type { BeneficiaryWalletView } from '@/lib/server/beneficiaryWallets'
import type { BeneficiaryListItem } from '@/lib/server/dto'
import type { Beneficiary } from '@/lib/store/types'
import { cn } from '@/lib/utils'

export function BeneficiariesPage({ initial }: { initial: BeneficiaryListItem[] }) {
  const { data } = useQuery({ queryKey: ['beneficiaries'], queryFn: () => listBeneficiaries(), initialData: initial, refetchInterval: 8_000 })
  const rows = data ?? initial
  const [selected, setSelected] = useState<string | null>(null)

  function handleClose(open: boolean) {
    if (!open) setSelected(null)
  }

  return (
    <>
      <PageHeader title="Beneficiaries" eyebrow={`${rows.filter((r) => r.status === 'active').length} active · approved wallets and 30-day limit enforced by the agent · EURC via Thyme from the Safe`} />
      <div className="mt-8 rounded-xl bg-surface">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Name</TableHead>
              <TableHead>Country</TableHead>
              <TableHead>Primary wallet</TableHead>
              <TableHead className="text-right">Trust</TableHead>
              <TableHead className="text-right">Limit / mo</TableHead>
              <TableHead className="text-right">This month</TableHead>
              <TableHead className="text-right">Total</TableHead>
              <TableHead>Last paid</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={9} className="py-10 text-center text-xs text-dim">
                  No beneficiaries yet. The first approved invoice registers one.
                </TableCell>
              </TableRow>
            ) : null}
            {rows.map((b) => (
              <TableRow key={b.id} className="cursor-pointer" onClick={() => setSelected(b.id)}>
                <TableCell>
                  <div className="font-medium">{b.name}</div>
                  <div className="text-xs text-dim">
                    {b.type} · {b.invoice_count} invoice{b.invoice_count === 1 ? '' : 's'}
                  </div>
                </TableCell>
                <TableCell className="font-mono text-xs">{b.country ?? '—'}</TableCell>
                <TableCell>{b.wallet ? <AddressMono value={b.wallet} /> : <span className="text-xs text-dim">none</span>}</TableCell>
                <TableCell className="text-right">
                  <ScoreRing value={b.trust_score} threshold={70} size="sm" className="ml-auto" />
                </TableCell>
                <TableCell className="text-right font-mono text-xs">{formatEur(b.monthly_limit_eur)}</TableCell>
                <TableCell className="text-right font-mono text-xs">{formatEur(b.paid_this_month_eur)}</TableCell>
                <TableCell className="text-right font-mono text-xs">{formatEur(b.total_paid_eur)}</TableCell>
                <TableCell className="text-xs text-dim">{b.last_paid_at ? <RelativeTime iso={b.last_paid_at} /> : '—'}</TableCell>
                <TableCell>
                  <StatusPill status={b.status} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <Sheet open={selected !== null} onOpenChange={handleClose}>
        <SheetContent side="right" className="w-full bg-surface sm:max-w-xl">{selected ? <BeneficiaryDetailSheet id={selected} /> : null}</SheetContent>
      </Sheet>
    </>
  )
}

function BeneficiaryDetailSheet({ id }: { id: string }) {
  const queryClient = useQueryClient()
  const { data } = useQuery({ queryKey: ['beneficiary', id], queryFn: () => getBeneficiary({ data: { id } }), refetchInterval: 5_000 })
  const status = useMutation({
    mutationFn: (next: Beneficiary['status']) => setBeneficiaryStatus({ data: { id, status: next } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['beneficiary', id] })
      await queryClient.invalidateQueries({ queryKey: ['beneficiaries'] })
    },
    onError: (e) => toast.error(e.message),
  })
  if (!data) return <div className="p-6 text-xs text-dim">Loading…</div>
  const { beneficiary: b, invoices, payouts, lastChecklist, wallets } = data

  function handlePause() {
    status.mutate(b.status === 'active' ? 'paused' : 'active')
  }
  function handleBlock() {
    status.mutate(b.status === 'blocked' ? 'active' : 'blocked')
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <SheetHeader>
        <SheetTitle className="flex items-center gap-3">
          {b.name}
          <StatusPill status={b.status} />
        </SheetTitle>
        <SheetDescription>
          {b.type} · {b.country ?? '—'} · {b.tax_id ?? 'no tax id'} · since {formatDate(b.created_at)}
        </SheetDescription>
      </SheetHeader>
      <div className="grid gap-5 px-4 pb-8">
        <div className="grid grid-cols-3 gap-3">
          <Tile label="Limit / mo" value={formatEur(b.monthly_limit_eur)} />
          <Tile label="This month" value={formatEur(data.paid_this_month_eur)} />
          <Tile label="Total paid" value={formatEur(b.total_paid_eur)} />
        </div>
        <div className="flex items-center justify-between text-xs">
          <span className="text-dim">Primary wallet</span>
          {b.wallet ? <AddressMono value={b.wallet} /> : <span className="text-dim">none</span>}
        </div>
        <div className="flex items-center justify-between text-xs">
          <span className="text-dim">Ownership proof</span>
          <span>{b.ownership_proof_json ? 'EIP-712 signature on file' : 'none'}</span>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={handlePause} disabled={status.isPending || b.status === 'blocked'}>
            {b.status === 'paused' ? 'Resume' : 'Pause'}
          </Button>
          <Button variant="outline" size="sm" className="border-blocked/40 text-blocked hover:bg-blocked/10 hover:text-blocked" onClick={handleBlock} disabled={status.isPending}>
            {b.status === 'blocked' ? 'Unblock' : 'Block'}
          </Button>
        </div>

        <WalletsSection beneficiaryId={b.id} beneficiaryName={b.name} wallets={wallets} />

        <section>
          <h3 className="mb-2 text-xs text-dim">Invoices</h3>
          <div className="divide-y divide-hairline">
            {invoices.map((i) => (
              <Link key={i.id} to="/invoices" search={{ id: i.id }} className="grid grid-cols-[1fr_auto_auto] items-center gap-3 py-2.5 text-xs hover:text-sage">
                <span className="font-mono">{i.number ?? i.id.slice(0, 8)}</span>
                <span className="font-mono">{formatMoney(i.amount, i.currency)}</span>
                <StatusPill status={i.status} />
              </Link>
            ))}
            {invoices.length === 0 ? <div className="py-2 text-xs text-dim">none</div> : null}
          </div>
        </section>

        <section>
          <h3 className="mb-2 text-xs text-dim">Payouts</h3>
          <div className="divide-y divide-hairline">
            {payouts.map((p) => (
              <div key={p.id} className="grid grid-cols-[1fr_auto_auto] items-center gap-3 py-2.5 text-xs">
                <span className="flex items-center gap-2">
                  {formatDate(p.created_at)}
                  {p.to_wallet ? <AddressMono value={p.to_wallet} copy={false} link={false} className="text-dim" /> : null}
                </span>
                <span className="font-mono">{formatEurc(p.amount_eurc)} EURC</span>
                <span className="flex items-center gap-2">
                  <StatusPill status={p.status} />
                  {p.tx_hash ? <AddressMono value={p.tx_hash} kind="tx" copy={false} link={!p.simulated} /> : null}
                </span>
              </div>
            ))}
            {payouts.length === 0 ? <div className="py-2 text-xs text-dim">none</div> : null}
          </div>
        </section>

        {lastChecklist ? (
          <section>
            <h3 className="mb-2 text-xs text-dim">Last checks · score {lastChecklist.score ?? '—'}</h3>
            {lastChecklist.entries.map((e) => (
              <CheckItem key={e.id} item={e} compact />
            ))}
          </section>
        ) : null}
      </div>
    </div>
  )
}

const WALLET_TONE: Record<BeneficiaryWalletView['status'], 'pass' | 'warn' | 'fail'> = { approved: 'pass', pending: 'warn', revoked: 'fail' }
const WALLET_SOURCE: Record<BeneficiaryWalletView['source'], string> = { registration: 'registered by the owner', invoice: 'printed on an invoice', manual: 'added by the owner' }

interface WalletsSectionProps {
  beneficiaryId: string
  beneficiaryName: string
  wallets: BeneficiaryWalletView[]
}

/** Wallet list of one beneficiary: status chips, primary star, add form, approve / revoke / make-primary actions. */
function WalletsSection({ beneficiaryId, beneficiaryName, wallets }: WalletsSectionProps) {
  const queryClient = useQueryClient()
  const [address, setAddress] = useState('')
  const [label, setLabel] = useState('')
  const [confirmId, setConfirmId] = useState<string | null>(null)

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: ['beneficiary', beneficiaryId] })
    await queryClient.invalidateQueries({ queryKey: ['beneficiaries'] })
    await queryClient.invalidateQueries({ queryKey: ['invoices'] })
  }

  const add = useMutation({
    mutationFn: () => addBeneficiaryWallet({ data: { beneficiaryId, wallet: address.trim(), label: label.trim() || null } }),
    onSuccess: async (w) => {
      toast.success(`Wallet ${w.wallet.slice(0, 6)}…${w.wallet.slice(-4)} added as pending; approve it to allow payouts`)
      setAddress('')
      setLabel('')
      await refresh()
    },
    onError: (e) => toast.error(e.message),
  })
  const approve = useMutation({
    mutationFn: (walletId: string) => approveBeneficiaryWallet({ data: { walletId } }),
    onSuccess: async (result) => {
      toast.success(result.message)
      for (const s of result.skipped) toast.warning(`${s.number ?? s.id.slice(0, 8)} not re-run: ${s.reason}`)
      setConfirmId(null)
      await refresh()
    },
    onError: (e) => toast.error(e.message),
  })
  const revoke = useMutation({
    mutationFn: (walletId: string) => revokeBeneficiaryWallet({ data: { walletId } }),
    onSuccess: async (w) => {
      toast.success(`Wallet ${w.wallet.slice(0, 6)}…${w.wallet.slice(-4)} revoked; it is never paid again`)
      await refresh()
    },
    onError: (e) => toast.error(e.message),
  })
  const primary = useMutation({
    mutationFn: (walletId: string) => setPrimaryBeneficiaryWallet({ data: { walletId } }),
    onSuccess: async () => {
      toast.success('Primary wallet updated')
      await refresh()
    },
    onError: (e) => toast.error(e.message),
  })

  function handleAddWallet(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!address.trim()) return
    add.mutate()
  }
  function handleAskApprove(walletId: string) {
    setConfirmId(walletId)
  }
  function handleCancelApprove() {
    setConfirmId(null)
  }
  function handleConfirmApprove(walletId: string) {
    approve.mutate(walletId)
  }
  function handleRevoke(walletId: string) {
    revoke.mutate(walletId)
  }
  function handleMakePrimary(walletId: string) {
    primary.mutate(walletId)
  }

  const busy = approve.isPending || revoke.isPending || primary.isPending
  const approvedCount = wallets.filter((w) => w.status === 'approved').length
  const pendingCount = wallets.filter((w) => w.status === 'pending').length

  return (
    <section>
      <h3 className="mb-2 flex items-center justify-between text-xs text-dim">
        <span>
          Wallets · {approvedCount} approved{pendingCount > 0 ? ` · ${pendingCount} pending owner approval` : ''}
        </span>
        <span>only approved wallets are paid</span>
      </h3>
      <div className="divide-y divide-hairline rounded-lg bg-raised px-3">
        {wallets.map((w) => (
          <div key={w.id} className="py-2.5 text-xs">
            <div className="grid grid-cols-[auto_1fr_auto] items-center gap-3">
              <span title={w.is_primary === 1 ? 'Primary wallet (default recipient)' : undefined} className="flex size-4 items-center justify-center">
                {w.is_primary === 1 ? <Star aria-label="primary" className="size-3 fill-sage text-sage" /> : <span className="size-1 rounded-full bg-track" />}
              </span>
              <span className="flex flex-wrap items-center gap-2">
                <AddressMono value={w.wallet} />
                <Chip tone={WALLET_TONE[w.status]}>{w.status}</Chip>
                {w.has_proof ? (
                  <span title="EIP-712 ownership proof on file" className="text-sage">
                    <ShieldCheck aria-label="ownership proof on file" className="size-3" />
                  </span>
                ) : (
                  <span title="No ownership proof: approved on the owner's word only" className="text-dim">
                    <ShieldOff aria-label="no ownership proof" className="size-3" />
                  </span>
                )}
                {w.label ? <span className="text-dim">{w.label}</span> : null}
              </span>
              <span className="flex items-center gap-1">
                {w.status === 'approved' && w.is_primary !== 1 ? (
                  <Button variant="ghost" size="xs" onClick={() => handleMakePrimary(w.id)} disabled={busy}>
                    Make primary
                  </Button>
                ) : null}
                {w.status === 'pending' ? (
                  <Button variant="secondary" size="xs" onClick={() => handleAskApprove(w.id)} disabled={busy || confirmId === w.id}>
                    Approve…
                  </Button>
                ) : null}
                {w.status !== 'revoked' ? (
                  <Button variant="ghost" size="xs" className="text-blocked hover:text-blocked" onClick={() => handleRevoke(w.id)} disabled={busy}>
                    <Ban aria-hidden />
                    Revoke
                  </Button>
                ) : null}
              </span>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 pl-7 text-dim">
              <span>{WALLET_SOURCE[w.source]}</span>
              {w.status === 'approved' ? <span>approved {w.approved_at ? formatDate(w.approved_at) : '—'} by {w.approved_by ?? 'owner'}</span> : null}
              {w.status === 'pending' ? <span>pending since {formatDate(w.created_at)}</span> : null}
              {w.paid_count > 0 ? (
                <span className="font-mono text-text">
                  {formatEur(w.paid_eur)} · {w.paid_count} payout{w.paid_count === 1 ? '' : 's'}
                </span>
              ) : null}
              {w.waiting_invoices.length > 0 ? (
                <span className="flex items-center gap-1">
                  waiting:
                  {w.waiting_invoices.map((i) => (
                    <Link key={i.id} to="/invoices" search={{ id: i.id }} className="font-mono text-paused hover:text-sage">
                      {i.number ?? i.id.slice(0, 8)}
                    </Link>
                  ))}
                </span>
              ) : null}
            </div>
            {confirmId === w.id ? (
              <div className={cn('mt-2 ml-7 rounded-md border border-paused/40 bg-surface p-3 text-xs')}>
                <div className="font-medium text-paused">Owner decision</div>
                <p className="mt-1 text-secondary-foreground">
                  Approving pays {beneficiaryName}'s invoices that print this wallet to it from now on. It {WALLET_SOURCE[w.source]}
                  {w.has_proof ? ' and carries an EIP-712 ownership proof' : ' and has no ownership proof: you vouch for it'}.
                  {w.waiting_invoices.length > 0 ? ` ${w.waiting_invoices.length} stopped invoice${w.waiting_invoices.length === 1 ? '' : 's'} will be re-checked and paid to it when clean.` : ''}
                  {w.source === 'invoice' ? ' A new wallet on an invoice of a known payee is the classic invoice-redirection fraud: confirm it with the contractor out of band first.' : ''}
                </p>
                <div className="mt-2 flex gap-2">
                  <Button size="xs" onClick={() => handleConfirmApprove(w.id)} disabled={approve.isPending}>
                    Approve as owner
                  </Button>
                  <Button variant="ghost" size="xs" onClick={handleCancelApprove} disabled={approve.isPending}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        ))}
        {wallets.length === 0 ? <div className="py-2 text-xs text-dim">no wallets on file</div> : null}
        <form onSubmit={handleAddWallet} className="flex items-center gap-2 py-2.5">
          <Input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="0x… new wallet address" className="h-8 flex-1 font-mono text-xs" aria-label="Wallet address" />
          <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="label (optional)" className="h-8 w-40 text-xs" aria-label="Wallet label" />
          <Button type="submit" variant="secondary" size="xs" disabled={add.isPending || !address.trim()}>
            <Plus aria-hidden />
            Add as pending
          </Button>
        </form>
      </div>
    </section>
  )
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-raised px-3 py-2.5">
      <div className="text-xs text-dim">{label}</div>
      <div className="mt-1 font-mono text-sm">{value}</div>
    </div>
  )
}
