import { Link } from '@tanstack/react-router'
import { Download, ExternalLink, ShieldCheck, TriangleAlert } from 'lucide-react'
import { useState } from 'react'
import { cn } from '@/lib/utils'
import { PageHeader, Section } from '@/components/shell/Shell'
import { formatEur, formatTime } from '@/components/ui-kit/format'
import { Stat } from '@/components/ui-kit/Stat'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import type { ReportsView } from '@/lib/server/dto'

export function ReportsPage({ data }: { data: ReportsView }) {
  const { comparison, month, months, audit, chain } = data
  const [auditLimit, setAuditLimit] = useState(40)

  function handleMore() {
    setAuditLimit((n) => n + 40)
  }

  return (
    <>
      <PageHeader
        title="Reports"
        eyebrow={comparison.periodLabel}
        actions={
          <>
            <Button asChild variant="secondary">
              <a href={`/api/reports/ledger?month=${month}`}>
                <Download aria-hidden />
                Ledger CSV
              </a>
            </Button>
            <Button asChild variant="secondary">
              <a href="/api/reports/audit">
                <Download aria-hidden />
                Audit JSONL
              </a>
            </Button>
          </>
        }
      />
      <div className="mt-4 flex flex-wrap gap-1.5">
        {months.map((m) => (
          <Link key={m} to="/reports" search={{ month: m }} className={cn('rounded-md px-2.5 py-1.5 font-mono text-xs transition-colors hover:bg-raised', m === month ? 'bg-raised text-text' : 'text-dim')}>
            {m}
          </Link>
        ))}
      </div>

      <Section
        title="Versus SWIFT"
        aside={
          <Sheet>
            <SheetTrigger asChild>
              <Button variant="ghost" size="sm" className="text-dim">
                Assumptions and sources
              </Button>
            </SheetTrigger>
            <SheetContent side="right" className="w-full bg-surface sm:max-w-xl">
              <SheetHeader>
                <SheetTitle>Assumptions and sources</SheetTitle>
                <SheetDescription>Every number on the card comes from a dated, linked source in config/rails.json.</SheetDescription>
              </SheetHeader>
              <div className="grid gap-3 overflow-y-auto px-4 pb-8">
                <div className="rounded-lg bg-raised p-3 text-xs text-dim">
                  If every payout had gone by SWIFT (incl. SEPA corridors): {formatEur(comparison.savedEurIfAllSwift)} saved. Headline counts fee savings on non-SEPA corridors only ({comparison.swiftCorridors} SWIFT, {comparison.sepaCorridors} SEPA). EURC fee is the mainnet-equivalent {formatEur(comparison.mainnetEquivalentFeeEur)}, not the ~0 Sepolia fee.
                </div>
                {comparison.sources.map((s) => (
                  <div key={s.key} className="border-b border-hairline pb-3 text-xs">
                    <div className="flex items-start justify-between gap-3">
                      <span>{s.label}</span>
                      <span className="shrink-0 font-mono text-secondary-foreground">{s.value}</span>
                    </div>
                    <div className="mt-1 flex items-center gap-2 text-dim">
                      <a href={s.source_url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 truncate hover:text-text">
                        {s.source_url.replace(/^https?:\/\//, '').slice(0, 60)}
                        <ExternalLink aria-hidden className="size-3" />
                      </a>
                      <span>· {s.fetched_on}</span>
                    </div>
                    {s.note ? <div className="mt-1 text-dim">{s.note}</div> : null}
                  </div>
                ))}
              </div>
            </SheetContent>
          </Sheet>
        }
      >
        <div data-tour="reports-comparison" className="rounded-xl bg-surface p-6">
          <div className="text-xl font-medium tracking-tightest">{comparison.headline}</div>
          <div className="mt-1 text-sm text-dim">{comparison.subline}</div>
          <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Saved vs SWIFT" value={formatEur(comparison.savedEur)} hint="fees, non-SEPA corridors" className="bg-raised" />
            <Stat label="Business days saved" value={comparison.savedBusinessDays.toLocaleString('en-IE', { maximumFractionDigits: 1 })} hint={`${Math.round(comparison.savedHours)} h`} className="bg-raised" />
            <Stat label="Payouts" value={comparison.confirmed} hint={formatEur(comparison.totalEur)} className="bg-raised" />
            <Stat label="Avg settlement" value={comparison.avgSettlementSeconds !== null ? `${Math.round(comparison.avgSettlementSeconds)}s` : '—'} hint="upload → block" className="bg-raised" />
          </div>
          {comparison.lines.length > 0 ? (
            <ul className="mt-5 grid gap-2 text-xs text-secondary-foreground">
              {comparison.lines.map((l) => (
                <li key={l.payoutId} className="leading-relaxed">
                  <span className="font-mono text-text">{l.invoiceNo ?? l.payoutId.slice(0, 8)}</span> · {l.sentence}
                </li>
              ))}
            </ul>
          ) : (
            <div className="mt-5 text-xs text-dim">No confirmed payouts in this period yet.</div>
          )}
        </div>
      </Section>

      <Section
        title="Audit log"
        aside={
          <span className={cn('inline-flex items-center gap-1.5 text-xs', chain.ok ? 'text-sage' : 'text-blocked')}>
            {chain.ok ? <ShieldCheck aria-hidden className="size-3.5" /> : <TriangleAlert aria-hidden className="size-3.5" />}
            {chain.message}
          </span>
        }
      >
        <div className="rounded-xl bg-surface">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Time</TableHead>
                <TableHead>Actor</TableHead>
                <TableHead>Event</TableHead>
                <TableHead>Invoice</TableHead>
                <TableHead>Details</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {audit.slice(0, auditLimit).map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="font-mono text-xs text-dim">{formatTime(e.ts)}</TableCell>
                  <TableCell className="text-xs">{e.actor}</TableCell>
                  <TableCell className={cn('font-mono text-xs', /reject|revert|fail|error/.test(e.event) && 'text-blocked')}>{e.event}</TableCell>
                  <TableCell className="text-xs">
                    {e.invoice_id ? (
                      <Link to="/invoices" search={{ id: e.invoice_id }} className="font-mono text-dim hover:text-text">
                        {e.invoice_id.slice(0, 8)}
                      </Link>
                    ) : null}
                  </TableCell>
                  <TableCell className="max-w-md truncate font-mono text-xs text-dim" title={e.details_json ?? ''}>
                    {e.details_json ?? ''}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {audit.length > auditLimit ? (
            <div className="p-3">
              <Button variant="ghost" size="sm" className="text-dim" onClick={handleMore}>
                Show more
              </Button>
            </div>
          ) : null}
        </div>
      </Section>
    </>
  )
}
