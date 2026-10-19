import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { FileText } from 'lucide-react'
import { PageHeader } from '@/components/shell/Shell'
import { AddressMono } from '@/components/ui-kit/AddressMono'
import { Chip } from '@/components/ui-kit/Chip'
import { formatCzk, formatDateTime, formatEur, formatEurc } from '@/components/ui-kit/format'
import { StatusPill } from '@/components/ui-kit/StatusPill'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import type { PayoutListItem } from '@/lib/server/dto'
import { listPayouts } from '@/lib/server/payouts.fns'

export function PayoutsPage({ initial }: { initial: PayoutListItem[] }) {
  const { data } = useQuery({ queryKey: ['payouts'], queryFn: () => listPayouts(), initialData: initial, refetchInterval: 5_000 })
  const rows = data ?? initial
  const total = rows.filter((r) => r.status === 'confirmed').reduce((s, r) => s + r.amount_eur, 0)
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
            {rows.map((p) => (
              <TableRow key={p.id}>
                <TableCell className="text-xs text-dim">{formatDateTime(p.confirmed_at ?? p.submitted_at ?? p.created_at)}</TableCell>
                <TableCell>
                  <Link to="/invoices" search={{ id: p.invoice_id }} className="font-mono text-xs hover:text-sage">
                    {p.invoice_number ?? p.invoice_id.slice(0, 8)}
                  </Link>
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
                </TableCell>
                <TableCell>{p.tx_hash ? <AddressMono value={p.tx_hash} kind="tx" link={!p.simulated} /> : <span className="text-xs text-dim">—</span>}</TableCell>
                <TableCell>
                  <StatusPill status={p.status} />
                  {p.error ? <div className="mt-1 max-w-48 truncate text-xs text-blocked" title={p.error}>{p.error}</div> : null}
                </TableCell>
                <TableCell className="text-right">
                  {p.status === 'confirmed' ? (
                    <Button asChild variant="ghost" size="sm" className="text-dim">
                      <a href={`/api/reports/remittance/${p.id}`} target="_blank" rel="noreferrer noopener">
                        <FileText aria-hidden />
                        Advice
                      </a>
                    </Button>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </>
  )
}
