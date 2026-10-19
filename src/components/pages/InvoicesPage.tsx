import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { LoaderCircle, Play, RotateCcw } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { type ApproveMode, InvestigationLog } from '@/components/invoices/InvestigationLog'
import { OverrideDialog } from '@/components/invoices/OverrideDialog'
import { RegisterDialog } from '@/components/invoices/RegisterDialog'
import { UploadButton } from '@/components/invoices/UploadButton'
import { formatMoney, formatTime } from '@/components/ui-kit/format'
import { StatusDot, toneForStatus } from '@/components/ui-kit/StatusDot'
import { Button } from '@/components/ui/button'
import type { InvoiceListItem, PayoutActionResult } from '@/lib/server/dto'
import { discardInvoice, forceInvoicePayout, getInvoice, listInvoices, quickRetryInvoice, registerBeneficiary, retryInvoice, runWorkerOnce, sendHeldInvoice } from '@/lib/server/invoices.fns'
import { checkPayoutStatus, discardPayout, retryPayout } from '@/lib/server/payouts.fns'

interface InvoicesPageProps {
  initial: InvoiceListItem[]
  selectedId?: string
}

const LIVE = new Set(['queued', 'investigating', 'approved', 'paying'])

/** Live = the agent or the rail is working on it; an approved invoice kept on hold is not. */
const isLive = (status: string, hold: boolean | undefined): boolean => LIVE.has(status) && !(status === 'approved' && hold)

export function InvoicesPage({ initial, selectedId }: InvoicesPageProps) {
  const queryClient = useQueryClient()
  const list = useQuery({
    queryKey: ['invoices'],
    queryFn: () => listInvoices(),
    initialData: initial,
    refetchInterval: (q) => (q.state.data?.some((i) => isLive(i.status, i.hold)) ? 2_000 : 10_000),
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
      const live = isLive(d.invoice.status, d.invoice.hold === 1) || d.payouts.some((p) => p.status === 'submitted' || p.status === 'pending')
      return live ? 1_200 : 8_000
    },
  })
  const [registerOpen, setRegisterOpen] = useState(false)
  const [overrideOpen, setOverrideOpen] = useState(false)

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ['invoice', id] })
    await queryClient.invalidateQueries({ queryKey: ['invoices'] })
    await queryClient.invalidateQueries({ queryKey: ['payouts'] })
    await queryClient.invalidateQueries({ queryKey: ['dashboard'] })
  }
  function reportPayout(result: PayoutActionResult) {
    const description = result.thymeStatus ? `Thyme: ${result.thymeStatus}${result.error ? ` · ${result.error}` : ''}` : (result.error ?? undefined)
    if (result.status === 'failed' || result.status === 'reverted') toast.warning(result.message, { description })
    else toast.message(result.message, { description })
  }

  const retry = useMutation({
    mutationFn: () => retryInvoice({ data: { id: id as string } }),
    onSuccess: async () => {
      await invalidate()
      toast.message('Checks queued again', { description: 'Same PDF, same beneficiary; the agent investigates it from scratch.' })
    },
    onError: (e) => toast.error(e.message),
  })
  const quickRetry = useMutation({
    mutationFn: (invoiceId: string) => quickRetryInvoice({ data: { id: invoiceId } }),
    onSuccess: async (r) => {
      await queryClient.invalidateQueries({ queryKey: ['invoices'] })
      await queryClient.invalidateQueries({ queryKey: ['invoice', quickRetry.variables] })
      await queryClient.invalidateQueries({ queryKey: ['payouts'] })
      toast.message(r.message)
    },
    onError: (e) => toast.error(e.message),
  })
  const discard = useMutation({
    mutationFn: () => discardInvoice({ data: { id: id as string } }),
    onSuccess: async (r) => {
      await invalidate()
      toast.message('Marked as failed', { description: r.discardedPayouts > 0 ? `${r.discardedPayouts} payout(s) discarded` : undefined })
    },
    onError: (e) => toast.error(e.message),
  })
  const retryPay = useMutation({
    mutationFn: (payoutId: string) => retryPayout({ data: { payoutId } }),
    onSuccess: async (r) => {
      await invalidate()
      reportPayout(r)
    },
    onError: (e) => toast.error(e.message),
  })
  const checkPay = useMutation({
    mutationFn: (payoutId: string) => checkPayoutStatus({ data: { payoutId } }),
    onSuccess: async (r) => {
      await invalidate()
      reportPayout(r)
    },
    onError: (e) => toast.error(e.message),
  })
  const discardPay = useMutation({
    mutationFn: (payoutId: string) => discardPayout({ data: { payoutId } }),
    onSuccess: async (r) => {
      await invalidate()
      reportPayout(r)
    },
    onError: (e) => toast.error(e.message),
  })
  const force = useMutation({
    mutationFn: () => forceInvoicePayout({ data: { id: id as string } }),
    onSuccess: async (r) => {
      await invalidate()
      if (r.status === 'reverted') toast.error('Chain reverted the transfer · no money moved')
      else if (r.status === 'failed') toast.error('Payment rail refused · no money moved')
      else toast.message(`Payout ${r.status}`)
    },
    onError: (e) => toast.error(e.message),
  })
  const approve = useMutation({
    mutationFn: (mode: ApproveMode) => {
      const d = detail.data
      if (!d?.beneficiary) throw new Error('no beneficiary on file')
      return registerBeneficiary({ data: { invoiceId: d.invoice.id, beneficiaryId: d.beneficiary.id, mode } })
    },
    onSuccess: async (r) => {
      await invalidate()
      if (r.hold) toast.success('Approved · on hold', { description: 'Nothing is sent until you click Send.' })
      else toast.success('Approved · payout queued')
    },
    onError: (e) => toast.error(e.message),
  })
  const send = useMutation({
    mutationFn: () => sendHeldInvoice({ data: { id: id as string } }),
    onSuccess: async () => {
      await invalidate()
      toast.success('Payout queued', { description: 'Wallet on file, through the payment agent.' })
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

  const busy = retry.isPending || force.isPending || approve.isPending || send.isPending || discard.isPending || retryPay.isPending || checkPay.isPending || discardPay.isPending

  function handleRegister() {
    setRegisterOpen(true)
  }
  function handleApprove(mode: ApproveMode) {
    approve.mutate(mode)
  }
  function handleSend() {
    send.mutate()
  }
  function handleOverride() {
    setOverrideOpen(true)
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
  function handleDiscard() {
    discard.mutate()
  }
  function handleRetryPayout(payoutId: string) {
    retryPay.mutate(payoutId)
  }
  function handleCheckPayout(payoutId: string) {
    checkPay.mutate(payoutId)
  }
  function handleDiscardPayout(payoutId: string) {
    discardPay.mutate(payoutId)
  }
  function handleQuickRetry(event: React.MouseEvent<HTMLButtonElement>, invoiceId: string) {
    event.preventDefault()
    event.stopPropagation()
    quickRetry.mutate(invoiceId)
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
          <UploadButton label="Demo invoices" icon="flask" variant="ghost" tab="demo" />
        </div>
        <nav className="mt-5 grid gap-0.5">
          {invoices.length === 0 ? <div className="rounded-lg bg-surface p-4 text-xs text-dim">No invoices yet. Upload a PDF or pick a demo invoice.</div> : null}
          {invoices.map((inv) => (
            <Link
              key={inv.id}
              to="/invoices"
              search={{ id: inv.id }}
              className={cn('grid grid-cols-[auto_1fr_auto_auto] items-center gap-2.5 rounded-lg px-3 py-2.5 text-xs transition-colors hover:bg-surface', inv.id === id && 'bg-surface')}
            >
              <StatusDot tone={inv.hold ? 'warn' : toneForStatus(inv.status)} pulse={isLive(inv.status, inv.hold)} />
              <div className="min-w-0">
                <div className={cn('flex items-center gap-1.5 truncate font-mono', inv.status === 'rejected' && 'text-blocked')}>
                  <span className="truncate">{inv.number ?? 'reading…'}</span>
                  {inv.override ? <span className="rounded-sm bg-blocked/15 px-1 py-0.5 font-sans text-blocked">overridden</span> : null}
                </div>
                <div className="truncate text-dim">
                  {inv.hold ? <span className="text-paused">on hold · </span> : null}
                  {inv.beneficiary_name ?? inv.payee_name ?? formatTime(inv.created_at)}
                </div>
              </div>
              <div className="text-right font-mono">{formatMoney(inv.amount, inv.currency)}</div>
              {inv.status === 'failed' ? (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="text-blocked hover:text-blocked"
                  onClick={(event) => handleQuickRetry(event, inv.id)}
                  disabled={quickRetry.isPending && quickRetry.variables === inv.id}
                  aria-label="Retry"
                  title="Retry: the failed payout again, or the checks when there is none"
                >
                  {quickRetry.isPending && quickRetry.variables === inv.id ? <LoaderCircle aria-hidden className="animate-spin" /> : <RotateCcw aria-hidden />}
                </Button>
              ) : (
                <span className="size-6" />
              )}
            </Link>
          ))}
        </nav>
      </aside>
      <div className="min-w-0">
        {current ? (
          <InvestigationLog
            detail={current}
            onRegister={handleRegister}
            onApprove={handleApprove}
            onSend={handleSend}
            onRetry={handleRetry}
            onOverride={handleOverride}
            onForce={handleForce}
            onDiscard={handleDiscard}
            onRetryPayout={handleRetryPayout}
            onCheckPayout={handleCheckPayout}
            onDiscardPayout={handleDiscardPayout}
            busy={busy}
          />
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
        {current && overrideOpen ? <OverrideDialog key={`override-${current.invoice.id}`} open={overrideOpen} onOpenChange={setOverrideOpen} detail={current} /> : null}
      </div>
    </div>
  )
}
