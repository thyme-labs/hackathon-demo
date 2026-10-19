import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { toast } from 'sonner'
import { PageHeader } from '@/components/shell/Shell'
import { AddressMono } from '@/components/ui-kit/AddressMono'
import { CheckItem } from '@/components/ui-kit/CheckItem'
import { formatDate, formatEur, formatEurc, formatMoney } from '@/components/ui-kit/format'
import { RelativeTime } from '@/components/ui-kit/RelativeTime'
import { ScoreRing } from '@/components/ui-kit/ScoreRing'
import { StatusPill } from '@/components/ui-kit/StatusPill'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { getBeneficiary, listBeneficiaries, setBeneficiaryStatus } from '@/lib/server/beneficiaries.fns'
import type { BeneficiaryListItem } from '@/lib/server/dto'
import type { Beneficiary } from '@/lib/store/types'

export function BeneficiariesPage({ initial }: { initial: BeneficiaryListItem[] }) {
  const { data } = useQuery({ queryKey: ['beneficiaries'], queryFn: () => listBeneficiaries(), initialData: initial, refetchInterval: 8_000 })
  const rows = data ?? initial
  const [selected, setSelected] = useState<string | null>(null)

  function handleClose(open: boolean) {
    if (!open) setSelected(null)
  }

  return (
    <>
      <PageHeader title="Beneficiaries" eyebrow={`${rows.filter((r) => r.status === 'active').length} active · limits enforced on chain`} />
      <div className="mt-8 rounded-xl bg-surface">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Name</TableHead>
              <TableHead>Country</TableHead>
              <TableHead>Wallet</TableHead>
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
  const { data } = useQuery({ queryKey: ['beneficiary', id], queryFn: () => getBeneficiary({ data: { id } }) })
  const status = useMutation({
    mutationFn: (next: Beneficiary['status']) => setBeneficiaryStatus({ data: { id, status: next } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['beneficiary', id] })
      await queryClient.invalidateQueries({ queryKey: ['beneficiaries'] })
    },
    onError: (e) => toast.error(e.message),
  })
  if (!data) return <div className="p-6 text-xs text-dim">Loading…</div>
  const { beneficiary: b, invoices, payouts, lastChecklist } = data

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
          <span className="text-dim">Wallet</span>
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
                <span>{formatDate(p.created_at)}</span>
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

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-raised px-3 py-2.5">
      <div className="text-xs text-dim">{label}</div>
      <div className="mt-1 font-mono text-sm">{value}</div>
    </div>
  )
}
