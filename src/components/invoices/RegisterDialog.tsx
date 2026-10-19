import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Check, LoaderCircle, Lock, Sparkles } from 'lucide-react'
import { type FormEvent, useState } from 'react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { AddressMono } from '@/components/ui-kit/AddressMono'
import { Chip, ChipLegend } from '@/components/ui-kit/Chip'
import { formatEur } from '@/components/ui-kit/format'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import type { BeneficiaryProposal } from '@/lib/agent/types'
import type { RegistrationPlan } from '@/lib/server/dto'
import { type ApprovalMode, type ApproveBeneficiaryInput, approveBeneficiary, registerBeneficiary } from '@/lib/server/invoices.fns'
import { simulateThymeOnboarding } from '@/lib/server/thyme.fns'

interface RegisterDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  invoiceId: string
  proposal: BeneficiaryProposal
  /** Existing beneficiary (held because of score/inactive), if any. */
  existing?: { id: string; name: string; wallet: string | null; monthly_limit_eur: number; country: string | null; type: 'person' | 'company'; tax_id: string | null } | null
}

type Phase = 'form' | 'review'

/**
 * "Register beneficiary + limit": confirm the payee and its 30-day limit. No Safe transaction: Thyme's
 * Roles scope (EURC.transfer from the Safe) was set once at onboarding; the wallet and the limit are
 * enforced by the payment agent before anything is handed to Thyme.
 */
export function RegisterDialog({ open, onOpenChange, invoiceId, proposal, existing }: RegisterDialogProps) {
  const queryClient = useQueryClient()
  const [phase, setPhase] = useState<Phase>('form')
  const [plan, setPlan] = useState<RegistrationPlan | null>(null)
  const [beneficiaryId, setBeneficiaryId] = useState<string | null>(existing?.id ?? null)
  const [form, setForm] = useState<ApproveBeneficiaryInput>({
    invoiceId,
    name: existing?.name ?? proposal.name,
    wallet: existing?.wallet ?? proposal.wallet ?? '',
    type: existing?.type ?? proposal.type,
    country: existing?.country ?? proposal.country,
    taxId: existing?.tax_id ?? proposal.tax_id,
    email: proposal.email,
    website: proposal.website,
    monthlyLimitEur: existing?.monthly_limit_eur || proposal.suggested_limit_eur,
  })

  const prepare = useMutation({
    mutationFn: (input: ApproveBeneficiaryInput) => approveBeneficiary({ data: input }),
    onSuccess: ({ beneficiary, plan: p }) => {
      setBeneficiaryId(beneficiary.id)
      setPlan(p)
      setPhase('review')
    },
    onError: (error) => toast.error(error.message),
  })

  const finish = useMutation({
    mutationFn: async ({ mode, simulateFirst }: { mode: ApprovalMode; simulateFirst: boolean }) => {
      if (!beneficiaryId) throw new Error('no beneficiary')
      if (simulateFirst) await simulateThymeOnboarding({ data: { safeAddress: plan?.safeAddress ?? null } })
      return registerBeneficiary({ data: { invoiceId, beneficiaryId, mode } })
    },
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ['invoice', invoiceId] })
      await queryClient.invalidateQueries({ queryKey: ['invoices'] })
      await queryClient.invalidateQueries({ queryKey: ['thyme-onboarding'] })
      await queryClient.invalidateQueries({ queryKey: ['dashboard'] })
      await queryClient.invalidateQueries({ queryKey: ['beneficiaries'] })
      onOpenChange(false)
      if (result.hold) toast.success('Beneficiary registered · approved, on hold', { description: 'Nothing is sent until you click Send on the invoice.' })
      else toast.success('Beneficiary registered · payout queued')
    },
    onError: (error) => toast.error(error.message),
  })

  function handleSubmit(event: FormEvent) {
    event.preventDefault()
    prepare.mutate(form)
  }
  function handleApproveHold() {
    finish.mutate({ mode: 'hold', simulateFirst: false })
  }
  function handleApproveSend() {
    // Without a Safe enabled, the rail is simulated first so the payout is labelled, not silently dropped.
    finish.mutate({ mode: 'send', simulateFirst: !plan?.ready })
  }
  function handleBack() {
    setPhase('form')
  }
  function handleCancel() {
    onOpenChange(false)
  }

  const set = (key: keyof ApproveBeneficiaryInput) => (event: FormEvent<HTMLInputElement>) => {
    const value = (event.target as HTMLInputElement).value
    setForm((f) => ({ ...f, [key]: key === 'monthlyLimitEur' ? Number(value) : value }))
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg bg-popover">
        {phase === 'form' ? (
          <form onSubmit={handleSubmit} className="grid gap-5">
            <DialogHeader>
              <DialogTitle>Register beneficiary</DialogTitle>
              <DialogDescription>Confirm the payee from the invoice and set a 30-day limit. The agent enforces both; Thyme can only move EURC from the Safe.</DialogDescription>
            </DialogHeader>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Name" className="col-span-2">
                <Input value={form.name} onChange={set('name')} required />
              </Field>
              <Field label="Wallet" className="col-span-2">
                <Input value={form.wallet} onChange={set('wallet')} className="font-mono text-xs" required />
              </Field>
              <Field label="Country">
                <Input value={form.country} onChange={set('country')} maxLength={2} className="uppercase" />
              </Field>
              <Field label="Type">
                <Input value={form.type} readOnly />
              </Field>
              <Field label="Tax ID">
                <Input value={form.taxId ?? ''} onChange={set('taxId')} />
              </Field>
              <Field label="Monthly limit (EUR)">
                <Input type="number" min={1} step={1} value={form.monthlyLimitEur} onChange={set('monthlyLimitEur')} className="font-mono" required />
              </Field>
            </div>
            <div className="text-xs text-dim">Suggested limit: {formatEur(proposal.suggested_limit_eur)} (2.5× this invoice, rounded to €100).</div>
            <DialogFooter>
              <Button type="button" variant="secondary" onClick={handleCancel}>
                Cancel
              </Button>
              <Button type="submit" disabled={prepare.isPending}>
                {prepare.isPending ? <LoaderCircle aria-hidden className="animate-spin" /> : null}
                Continue
              </Button>
            </DialogFooter>
          </form>
        ) : null}

        {phase === 'review' && plan ? (
          <div className="grid gap-5">
            <DialogHeader>
              <DialogTitle>Confirm registration</DialogTitle>
              <DialogDescription>{plan.reason}</DialogDescription>
            </DialogHeader>
            <div className="flex flex-wrap gap-1.5">
              <Chip variant="agent">{plan.payees} payee{plan.payees === 1 ? '' : 's'}</Chip>
              <Chip variant="agent">≤ {formatEur(form.monthlyLimitEur)}/30 d</Chip>
              <Chip variant="chain">EURC only</Chip>
              <Chip variant="chain">transfer only</Chip>
              <Chip variant="chain">via Thyme on the Safe</Chip>
            </div>
            <div className="grid grid-cols-2 gap-6">
              <div>
                <h3 className="mb-3 flex items-center gap-1.5 text-xs text-dim">
                  <Lock aria-hidden className="size-3" />
                  Chain (Thyme Roles scope)
                </h3>
                {plan.chain.map((line) => (
                  <div key={line} className="my-2.5 flex items-start gap-2 text-xs text-secondary-foreground">
                    <Check aria-hidden className="mt-0.5 size-3.5 shrink-0 text-sage" />
                    {line}
                  </div>
                ))}
              </div>
              <div>
                <h3 className="mb-3 flex items-center gap-1.5 text-xs text-dim">
                  <Sparkles aria-hidden className="size-3" />
                  Agent (before every payout)
                </h3>
                {plan.agent.map((line) => (
                  <div key={line} className="my-2.5 flex items-start gap-2 text-xs text-secondary-foreground">
                    <Check aria-hidden className="mt-0.5 size-3.5 shrink-0 text-sage" />
                    {line}
                  </div>
                ))}
              </div>
            </div>
            <div className="flex items-center justify-between border-t border-hairline pt-3 text-xs text-dim">
              <span>Safe</span>
              <span className="font-mono">{plan.safeAddress ? <AddressMono value={plan.safeAddress} /> : 'not enabled yet'}</span>
            </div>
            {!plan.ready ? (
              <div className="rounded-lg border border-paused/30 bg-paused/10 p-3 text-xs">
                <div className="text-paused">Payroll is not enabled on a Safe yet</div>
                <div className="mt-1 text-dim">
                  Enable it once with the owner wallet (one transaction), or continue with a labelled simulation for the demo. "Approve" alone sends nothing and needs no rail.
                </div>
                <div className="mt-3">
                  <Button asChild size="sm" variant="secondary">
                    <Link to="/onboarding">Enable payroll on the Safe</Link>
                  </Button>
                </div>
              </div>
            ) : null}
            <div className="flex items-center justify-between gap-4 text-xs text-dim">
              <span>
                <span className="text-text">Approve</span> registers the payee and holds the payout for a later <span className="text-text">Send</span>. <span className="text-text">Approve &amp; send</span> queues it now.
              </span>
              <ChipLegend className="shrink-0" />
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" className="text-dim" onClick={handleBack} disabled={finish.isPending}>
                Back
              </Button>
              <Button type="button" variant="secondary" onClick={handleApproveHold} disabled={finish.isPending}>
                {finish.isPending && finish.variables?.mode === 'hold' ? <LoaderCircle aria-hidden className="animate-spin" /> : <Check aria-hidden />}
                Approve
              </Button>
              <Button type="button" variant={plan.ready && !plan.simulated ? 'default' : 'outline'} onClick={handleApproveSend} disabled={finish.isPending}>
                {finish.isPending && finish.variables?.mode === 'send' ? <LoaderCircle aria-hidden className="animate-spin" /> : null}
                {plan.ready ? (plan.simulated ? 'Approve & send (simulated)' : 'Approve & send') : 'Approve & send (simulate rail)'}
              </Button>
            </DialogFooter>
          </div>
        ) : null}
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
