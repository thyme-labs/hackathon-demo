import { useMutation, useQueryClient } from '@tanstack/react-query'
import { LoaderCircle, ShieldAlert } from 'lucide-react'
import { type FormEvent, useState } from 'react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { AddressMono } from '@/components/ui-kit/AddressMono'
import { Chip } from '@/components/ui-kit/Chip'
import { formatMoney } from '@/components/ui-kit/format'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import type { InvoiceDetail } from '@/lib/server/dto'
import { type OverrideRegistration, overridePayout } from '@/lib/server/invoices.fns'

interface OverrideDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  detail: InvoiceDetail
}

const TIER_TONE = { critical: 'text-blocked', high: 'text-blocked', medium: 'text-paused', low: 'text-dim' } as const

/**
 * "Send anyway": the owner acknowledges every failed (and critical-warn) check one by one, writes a reason and
 * confirms. The server logs owner.override and enqueues the payout the normal way (wallet on file, through Thyme).
 */
export function OverrideDialog({ open, onOpenChange, detail }: OverrideDialogProps) {
  const queryClient = useQueryClient()
  const { invoice, beneficiary, overrideChecks, checklist, extracted } = detail
  const proposal = checklist.proposal
  const [acknowledged, setAcknowledged] = useState<Set<string>>(() => new Set())
  const [reason, setReason] = useState('')
  const [registration, setRegistration] = useState<OverrideRegistration>({
    name: proposal?.name ?? invoice.payee_name ?? '',
    wallet: proposal?.wallet ?? invoice.payee_wallet ?? '',
    monthlyLimitEur: proposal?.suggested_limit_eur ?? Math.max(100, Math.ceil(((invoice.amount_eur ?? invoice.amount ?? 0) * 2.5) / 100) * 100),
  })
  const needsRegistration = !beneficiary
  const allAcknowledged = overrideChecks.every((c) => acknowledged.has(c.id))
  const reasonOk = reason.trim().length >= 3
  const registrationOk = !needsRegistration || (registration.name.trim() !== '' && /^0x[0-9a-fA-F]{40}$/.test(registration.wallet.trim()) && registration.monthlyLimitEur > 0)
  const canConfirm = allAcknowledged && reasonOk && registrationOk
  const amount = formatMoney(invoice.amount_eur ?? invoice.amount, invoice.amount_eur ? 'EUR' : invoice.currency)
  const pdfWallet = extracted?.payment.wallet ?? invoice.payee_wallet
  const walletDiffers = Boolean(beneficiary?.wallet && pdfWallet && beneficiary.wallet.toLowerCase() !== pdfWallet.toLowerCase())

  const confirm = useMutation({
    mutationFn: () =>
      overridePayout({
        data: { invoiceId: invoice.id, acknowledgedCheckIds: [...acknowledged], reason: reason.trim(), registration: needsRegistration ? registration : null },
      }),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ['invoice', invoice.id] })
      await queryClient.invalidateQueries({ queryKey: ['invoices'] })
      await queryClient.invalidateQueries({ queryKey: ['payouts'] })
      await queryClient.invalidateQueries({ queryKey: ['dashboard'] })
      await queryClient.invalidateQueries({ queryKey: ['beneficiaries'] })
      onOpenChange(false)
      toast.warning('Override recorded · payout queued', { description: result.to ? `To the wallet on file ${result.to.slice(0, 6)}…${result.to.slice(-4)} · audit owner.override` : 'audit owner.override' })
    },
    onError: (error) => toast.error(error.message),
  })

  function handleToggle(id: string, checked: boolean | 'indeterminate') {
    setAcknowledged((set) => {
      const next = new Set(set)
      if (checked === true) next.add(id)
      else next.delete(id)
      return next
    })
  }
  function handleReason(event: FormEvent<HTMLTextAreaElement>) {
    setReason((event.target as HTMLTextAreaElement).value)
  }
  function handleRegistration(key: keyof OverrideRegistration) {
    return (event: FormEvent<HTMLInputElement>) => {
      const value = (event.target as HTMLInputElement).value
      setRegistration((r) => ({ ...r, [key]: key === 'monthlyLimitEur' ? Number(value) : value }))
    }
  }
  function handleSubmit(event: FormEvent) {
    event.preventDefault()
    if (!canConfirm || confirm.isPending) return
    confirm.mutate()
  }
  function handleCancel() {
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg bg-popover">
        <form onSubmit={handleSubmit} className="grid gap-5">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-blocked">
              <ShieldAlert aria-hidden className="size-4" />
              Send anyway
            </DialogTitle>
            <DialogDescription>
              The agent stopped this invoice. Paying {amount} now is your decision: acknowledge every failed check, give a reason, and the override is written to the audit log with your name on it.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-2">
            <div className="text-xs text-dim">Failed and critical checks ({overrideChecks.length})</div>
            {overrideChecks.length === 0 ? <div className="rounded-lg bg-surface p-3 text-xs text-dim">No failed check is recorded on this invoice.</div> : null}
            {overrideChecks.map((check) => {
              const id = `ack-${check.id}`
              return (
                <label key={check.id} htmlFor={id} className={cn('flex cursor-pointer items-start gap-3 rounded-lg bg-surface p-3 text-xs transition-colors hover:bg-raised', acknowledged.has(check.id) && 'bg-raised')}>
                  <Checkbox id={id} checked={acknowledged.has(check.id)} onCheckedChange={(checked) => handleToggle(check.id, checked)} className="mt-0.5" required />
                  <span className="min-w-0">
                    <span className="block">
                      I understand: <span className={cn('font-medium', TIER_TONE[check.tier])}>{check.label}</span> {check.status === 'fail' ? 'failed' : 'warned'}
                      <Chip tone={check.status === 'fail' ? 'fail' : 'warn'} className="ml-2 py-0.5">
                        {check.tier}
                      </Chip>
                    </span>
                    {check.evidence ? <span className="mt-1 block break-words text-dim">— {check.evidence}</span> : null}
                  </span>
                </label>
              )
            })}
          </div>

          {needsRegistration ? (
            <div className="grid gap-3 rounded-lg border border-paused/30 bg-paused/10 p-3">
              <div className="text-xs text-paused">No payee on file. Register the beneficiary you vouch for; the payout goes to this wallet.</div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Name" className="col-span-2">
                  <Input value={registration.name} onChange={handleRegistration('name')} required />
                </Field>
                <Field label="Wallet" className="col-span-2">
                  <Input value={registration.wallet} onChange={handleRegistration('wallet')} className="font-mono text-xs" required />
                </Field>
                <Field label="Monthly limit (EUR)">
                  <Input type="number" min={1} step={1} value={registration.monthlyLimitEur} onChange={handleRegistration('monthlyLimitEur')} className="font-mono" required />
                </Field>
              </div>
            </div>
          ) : (
            <div className="rounded-lg bg-surface p-3 text-xs">
              <div className="text-dim">Recipient (wallet on file, never the wallet printed on the PDF)</div>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <span>{beneficiary.name}</span>
                {beneficiary.wallet ? <AddressMono value={beneficiary.wallet} /> : <span className="text-blocked">no wallet on file</span>}
              </div>
              {walletDiffers && pdfWallet ? (
                <div className="mt-2 text-blocked">
                  The PDF asks for <AddressMono value={pdfWallet} copy={false} /> — that wallet is not paid.
                </div>
              ) : null}
            </div>
          )}

          <Field label="Reason (required, goes to the audit log)">
            <Textarea value={reason} onChange={handleReason} placeholder="e.g. Verified the invoice with Anna by phone; the wallet on file is correct." className="min-h-20 text-sm" required minLength={3} />
          </Field>

          <DialogFooter>
            <Button type="button" variant="secondary" onClick={handleCancel} disabled={confirm.isPending}>
              Cancel
            </Button>
            <Button type="submit" variant="outline" className="border-blocked/40 text-blocked hover:bg-blocked/10 hover:text-blocked" disabled={!canConfirm || confirm.isPending}>
              {confirm.isPending ? <LoaderCircle aria-hidden className="animate-spin" /> : <ShieldAlert aria-hidden />}
              Pay despite failed checks
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function Field({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={cn('grid gap-1.5 text-xs text-dim', className)}>
      {label}
      {children}
    </label>
  )
}
