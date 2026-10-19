import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { FileText, LoaderCircle, RefreshCw, RotateCcw, X } from 'lucide-react'
import { toast } from 'sonner'
import { PageHeader } from '@/components/shell/Shell'
import { AddressMono } from '@/components/ui-kit/AddressMono'
import { Chip } from '@/components/ui-kit/Chip'
import { formatCzk, formatDateTime, formatEur, formatEurc } from '@/components/ui-kit/format'
import { StatusPill } from '@/components/ui-kit/StatusPill'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import type { PayoutActionResult, PayoutListItem } from '@/lib/server/dto'
import { checkPayoutStatus, discardPayout, listPayouts, retryPayout } from '@/lib/server/payouts.fns'

export function PayoutsPage({ initial }: { initial: PayoutListItem[] }) {
  const queryClient = useQueryClient()
  const { data } = useQuery({ queryKey: ['payouts'], queryFn: () => listPayouts(), initialData: initial, refetchInterval: 5_000 })
  const rows = data ?? initial
  const total = rows.filter((r) => r.status === 'confirmed').reduce((s, r) => s + r.amount_eur, 0)

  async function invalidate() {
    await queryClient.invalidateQueries({ queryKey: ['payouts'] })
    await queryClient.invalidateQueries({ queryKey: ['invoices'] })
    await queryClient.invalidateQueries({ queryKey: ['dashboard'] })
  }
  function report(result: PayoutActionResult) {
    const description = result.thymeStatus ? `Thyme: ${result.thymeStatus}${result.error ? ` · ${result.error}` : ''}` : (result.error ?? undefined)
    if (result.status === 'failed' || result.status === 'reverted') toast.warning(result.message, { description })
    else toast.message(result.message, { description })
  }
  const retry = useMutation({
    mutationFn: (payoutId: string) => retryPayout({ data: { payoutId } }),
    onSuccess: async (r) => {
      await invalidate()
      report(r)
    },
    onError: (e) => toast.error(e.message),
  })
  const check = useMutation({
    mutationFn: (payoutId: string) => checkPayoutStatus({ data: { payoutId } }),
    onSuccess: async (r) => {
      await invalidate()
      report(r)
    },
    onError: (e) => toast.error(e.message),
  })
  const discard = useMutation({
    mutationFn: (payoutId: string) => discardPayout({ data: { payoutId } }),
    onSuccess: async (r) => {
      await invalidate()
      report(r)
    },
    onError: (e) => toast.error(e.message),
  })
  const busyId = retry.isPending ? retry.variables : check.isPending ? check.variables : discard.isPending ? discard.variables : null

  function handleRetry(id: string) {
    retry.mutate(id)
  }
  function handleCheck(id: string) {
    check.mutate(id)
  }
  function handleDiscard(id: string) {
    discard.mutate(id)
  }

  return (
    <>
      <PageHeader title="Payouts" eyebrow={`${rows.filter((r) => r.status === 'confirmed').length} confirmed · ${formatEur(total)} sent`} />
      <div className="mt-8 rounded-xl bg-surface">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>When</TableHead>
              <TableHead>Invoice</TableHead>
              <TableHead>Beneficiary</TableHead>
              <TableHead className="text-right">EURC</TableHead>
              <TableHead className="text-right">CZK (ČNB)</TableHead>
              <TableHead>Executor</TableHead>
              <TableHead>Tx</TableHead>
              <TableHead>Status</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={9} className="py-10 text-center text-xs text-dim">
                  No payouts yet.
                </TableCell>
              </TableRow>
            ) : null}
            {rows.map((p) => {
              const inFlight = p.status === 'pending' || p.status === 'submitted'
              const failed = p.status === 'failed' || p.status === 'reverted'
              const rowBusy = busyId === p.id
              return (
                <TableRow key={p.id}>
                  <TableCell className="text-xs text-dim">{formatDateTime(p.confirmed_at ?? p.submitted_at ?? p.created_at)}</TableCell>
                  <TableCell>
                    <Link to="/invoices" search={{ id: p.invoice_id }} className="font-mono text-xs hover:text-sage">
                      {p.invoice_number ?? p.invoice_id.slice(0, 8)}
                    </Link>
                    {p.attempt > 1 ? <div className="text-xs text-dim">attempt {p.attempt}</div> : null}
                  </TableCell>
                  <TableCell>
                    <div className="text-sm">{p.beneficiary_name ?? '—'}</div>
                    <div className="text-xs text-dim">{p.to_wallet ? <AddressMono value={p.to_wallet} copy={false} /> : null}</div>
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs">
                    {formatEurc(p.amount_eurc)}
                    {p.currency !== 'EUR' ? <div className="text-dim">{p.currency} @ {p.fx_rate ?? '—'}</div> : null}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs">
                    {p.amount_czk ? formatCzk(p.amount_czk) : '—'}
                    {p.cnb_rate ? <div className="text-dim">{p.cnb_rate} · {p.cnb_valid_for}</div> : null}
                  </TableCell>
                  <TableCell className="text-xs">
                    {p.executor}
                    {p.simulated ? <Chip tone="warn" className="ml-2">simulated</Chip> : null}
                    {p.override ? (
                      <Chip tone="fail" className="ml-2" title="Sent by the owner despite failed checks (audit owner.override)">
                        overridden
                      </Chip>
                    ) : null}
                    {p.thyme_execution_id ? <div className="max-w-32 truncate font-mono text-dim" title={p.thyme_execution_id}>{p.thyme_execution_id}</div> : null}
                  </TableCell>
                  <TableCell>{p.tx_hash ? <AddressMono value={p.tx_hash} kind="tx" link={!p.simulated} /> : <span className="text-xs text-dim">—</span>}</TableCell>
                  <TableCell>
                    <StatusPill status={p.status} />
                    {p.stuck ? <div className="mt-1 text-xs text-paused">no result for 5+ min</div> : null}
                    {p.error ? <div className="mt-1 max-w-40 truncate text-xs text-blocked" title={p.error}>{p.error}</div> : null}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex flex-nowrap justify-end gap-1">
                      {p.status === 'confirmed' ? (
                        <Button asChild variant="ghost" size="xs" className="text-dim">
                          <a href={`/api/reports/remittance/${p.id}`} target="_blank" rel="noreferrer noopener">
                            <FileText aria-hidden />
                            Advice
                          </a>
                        </Button>
                      ) : null}
                      {failed ? (
                        <Button variant="secondary" size="icon-xs" onClick={() => handleRetry(p.id)} disabled={rowBusy} aria-label="Retry" title="Retry: re-trigger Thyme with a new Idempotency-Key">
                          {rowBusy && retry.isPending ? <LoaderCircle aria-hidden className="animate-spin" /> : <RotateCcw aria-hidden />}
                        </Button>
                      ) : null}
                      {inFlight ? (
                        <>
                          <Button variant="ghost" size="icon-xs" className="text-dim" onClick={() => handleCheck(p.id)} disabled={rowBusy} aria-label="Check status" title="Check status: re-read the Thyme execution by id">
                            {rowBusy && check.isPending ? <LoaderCircle aria-hidden className="animate-spin" /> : <RefreshCw aria-hidden />}
                          </Button>
                          {p.stuck ? (
                            <Button variant="secondary" size="icon-xs" onClick={() => handleRetry(p.id)} disabled={rowBusy} aria-label="Retry" title="Retry: re-arm with a new Idempotency-Key (refused while Thyme reports it running)">
                              {rowBusy && retry.isPending ? <LoaderCircle aria-hidden className="animate-spin" /> : <RotateCcw aria-hidden />}
                            </Button>
                          ) : null}
                          <Button variant="ghost" size="icon-xs" className="text-blocked hover:text-blocked" onClick={() => handleDiscard(p.id)} disabled={rowBusy} aria-label="Discard" title="Discard: mark as failed so the queue moves on">
                            {rowBusy && discard.isPending ? <LoaderCircle aria-hidden className="animate-spin" /> : <X aria-hidden />}
                          </Button>
                        </>
                      ) : null}
                      {p.status === 'confirmed' && p.thyme_execution_id && !p.simulated ? (
                        <Button variant="ghost" size="icon-xs" className="text-dim" onClick={() => handleCheck(p.id)} disabled={rowBusy} aria-label="Check status at Thyme" title="Check status: re-read the Thyme execution by id">
                          {rowBusy && check.isPending ? <LoaderCircle aria-hidden className="animate-spin" /> : <RefreshCw aria-hidden />}
                        </Button>
                      ) : null}
                    </div>
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>
    </>
  )
}
