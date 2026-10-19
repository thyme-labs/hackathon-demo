import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useLoaderData } from '@tanstack/react-router'
import { Play } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { DemoDrawer } from '@/components/invoices/DemoDrawer'
import { InvestigationLog } from '@/components/invoices/InvestigationLog'
import { RegisterDialog } from '@/components/invoices/RegisterDialog'
import { UploadButton } from '@/components/invoices/UploadButton'
import { formatMoney, formatTime } from '@/components/ui-kit/format'
import { StatusDot, toneForStatus } from '@/components/ui-kit/StatusDot'
import { Button } from '@/components/ui/button'
import type { InvoiceListItem } from '@/lib/server/dto'
import { confirmInstall, forceInvoicePayout, getInvoice, listInvoices, retryInvoice, runWorkerOnce } from '@/lib/server/invoices.fns'

interface InvoicesPageProps {
  initial: InvoiceListItem[]
  selectedId?: string
}

const LIVE = new Set(['queued', 'investigating', 'approved', 'paying'])

export function InvoicesPage({ initial, selectedId }: InvoicesPageProps) {
  const queryClient = useQueryClient()
  const publicConfig = useLoaderData({ from: '__root__' })
  const threshold = publicConfig.autoPayThreshold
  const list = useQuery({
    queryKey: ['invoices'],
    queryFn: () => listInvoices(),
    initialData: initial,
    refetchInterval: (q) => (q.state.data?.some((i) => LIVE.has(i.status)) ? 2_000 : 10_000),
  })
  const invoices = list.data ?? initial
  const id = selectedId ?? invoices[0]?.id
  const detail = useQuery({
    queryKey: ['invoice', id],
    queryFn: () => getInvoice({ data: { id: id as string } }),
    enabled: Boolean(id),
    refetchInterval: (q) => {
      const d = q.state.data
      if (!d) return 1_500
      const live = LIVE.has(d.invoice.status) || d.payouts.some((p) => p.status === 'submitted' || p.status === 'pending')
      return live ? 1_200 : 8_000
    },
  })
  const [registerOpen, setRegisterOpen] = useState(false)

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ['invoice', id] })
    await queryClient.invalidateQueries({ queryKey: ['invoices'] })
  }

  const retry = useMutation({
    mutationFn: () => retryInvoice({ data: { id: id as string } }),
    onSuccess: invalidate,
    onError: (e) => toast.error(e.message),
  })
  const force = useMutation({
    mutationFn: () => forceInvoicePayout({ data: { id: id as string } }),
    onSuccess: async (r) => {
      await invalidate()
      if (r.status === 'reverted') toast.error('Chain reverted the transfer · no money moved')
      else toast.message(`Payout ${r.status}`)
    },
    onError: (e) => toast.error(e.message),
  })
  const approve = useMutation({
    mutationFn: () => {
      const d = detail.data
      if (!d?.beneficiary) throw new Error('no beneficiary on file')
      return confirmInstall({ data: { invoiceId: d.invoice.id, beneficiaryId: d.beneficiary.id, mode: 'none', txHash: null, rolesProxy: null, roleKey: null, mandateId: null, simulated: true } })
    },
    onSuccess: async () => {
      await invalidate()
      toast.success('Approved · payout queued')
    },
    onError: (e) => toast.error(e.message),
  })
  const runNow = useMutation({
    mutationFn: () => runWorkerOnce(),
    onSuccess: async (r) => {
      await invalidate()
      toast.message(r.investigated ? 'Investigated one invoice' : r.payouts ? `${r.payouts} payout(s) executed` : 'Nothing to do')
    },
    onError: (e) => toast.error(e.message),
  })

  const busy = retry.isPending || force.isPending || approve.isPending

  function handleRegister() {
    setRegisterOpen(true)
  }
  function handleApprove() {
    approve.mutate()
  }
  function handleRetry() {
    retry.mutate()
  }
  function handleForce() {
    force.mutate()
  }
  function handleRunNow() {
    runNow.mutate()
  }

  const current = detail.data
  const proposal = current?.checklist.proposal

  return (
    <div className="grid gap-8 lg:grid-cols-[18rem_1fr]">
      <aside className="min-w-0">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-medium tracking-tightest">Invoices</h1>
          <Button variant="ghost" size="icon-sm" className="text-dim" onClick={handleRunNow} disabled={runNow.isPending} aria-label="Run agent now" title="Run agent now">
            <Play aria-hidden />
          </Button>
        </div>
        <div className="mt-4 flex gap-1.5">
          <UploadButton />
          <DemoDrawer />
        </div>
        <nav className="mt-5 grid gap-0.5">
          {invoices.length === 0 ? <div className="rounded-lg bg-surface p-4 text-xs text-dim">No invoices yet. Upload a PDF or pick a demo invoice.</div> : null}
          {invoices.map((inv) => (
            <Link
              key={inv.id}
              to="/invoices"
              search={{ id: inv.id }}
              className={cn('grid grid-cols-[auto_1fr_auto] items-center gap-2.5 rounded-lg px-3 py-2.5 text-xs transition-colors hover:bg-surface', inv.id === id && 'bg-surface')}
            >
              <StatusDot tone={toneForStatus(inv.status)} pulse={LIVE.has(inv.status)} />
              <div className="min-w-0">
                <div className={cn('truncate font-mono', inv.status === 'rejected' && 'text-blocked')}>{inv.number ?? 'reading…'}</div>
                <div className="truncate text-dim">{inv.beneficiary_name ?? inv.payee_name ?? formatTime(inv.created_at)}</div>
              </div>
              <div className="text-right font-mono">{formatMoney(inv.amount, inv.currency)}</div>
            </Link>
          ))}
        </nav>
      </aside>
      <div className="min-w-0">
        {current ? (
          <InvestigationLog detail={current} autoPayThreshold={threshold} onRegister={handleRegister} onApprove={handleApprove} onRetry={handleRetry} onForce={handleForce} busy={busy} />
        ) : id ? (
          <div className="text-xs text-dim">Loading…</div>
        ) : (
          <div className="mx-auto max-w-md pt-20 text-center">
            <h2 className="text-2xl font-medium tracking-tightest">Queue is empty</h2>
            <p className="mt-2 text-sm text-dim">Upload a contractor invoice. The agent extracts it, runs twelve checks and pays in EURC when every rule is green.</p>
          </div>
        )}
        {current && proposal ? (
          <RegisterDialog
            key={current.invoice.id}
            open={registerOpen}
            onOpenChange={setRegisterOpen}
            invoiceId={current.invoice.id}
            proposal={proposal}
            existing={current.beneficiary ? { id: current.beneficiary.id, name: current.beneficiary.name, wallet: current.beneficiary.wallet, monthly_limit_eur: current.beneficiary.monthly_limit_eur, country: current.beneficiary.country, type: current.beneficiary.type, tax_id: current.beneficiary.tax_id } : null}
          />
        ) : null}
      </div>
    </div>
  )
}
