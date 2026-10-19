import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Check, ChevronRight, LoaderCircle, X } from 'lucide-react'
import { type FormEvent, useState } from 'react'
import { toast } from 'sonner'
import { type Address, getAddress, type Hex } from 'viem'
import { useAccount, usePublicClient, useWriteContract } from 'wagmi'
import { cn } from '@/lib/utils'
import { AddressMono } from '@/components/ui-kit/AddressMono'
import { Chip, ChipLegend } from '@/components/ui-kit/Chip'
import { formatEur } from '@/components/ui-kit/format'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { buildExecTransactionCall } from '@/lib/chain/safe'
import { SEPOLIA_CHAIN_ID } from '@/lib/roles/constants'
import type { BeneficiaryProposal } from '@/lib/agent/types'
import type { MandatePlan } from '@/lib/server/dto'
import { type ApproveBeneficiaryInput, approveBeneficiary, confirmInstall } from '@/lib/server/invoices.fns'

interface RegisterDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  invoiceId: string
  proposal: BeneficiaryProposal
  /** Existing beneficiary (held because of score/inactive), if any. */
  existing?: { id: string; name: string; wallet: string | null; monthly_limit_eur: number; country: string | null; type: 'person' | 'company'; tax_id: string | null } | null
}

type Phase = 'form' | 'review' | 'signing' | 'done'

/** "Register beneficiary + limit": one dialog, one Safe transaction (or a simulated signature without a wallet). */
export function RegisterDialog({ open, onOpenChange, invoiceId, proposal, existing }: RegisterDialogProps) {
  const queryClient = useQueryClient()
  const { address, isConnected } = useAccount()
  const publicClient = usePublicClient()
  const { writeContractAsync } = useWriteContract()

  const [phase, setPhase] = useState<Phase>('form')
  const [plan, setPlan] = useState<MandatePlan | null>(null)
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
  const [showCalls, setShowCalls] = useState(false)

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
    mutationFn: async (txHash: Hex | null) => {
      if (!plan || !beneficiaryId) throw new Error('no plan')
      return confirmInstall({
        data: {
          invoiceId,
          beneficiaryId,
          mode: plan.mode,
          txHash,
          rolesProxy: plan.rolesProxy,
          roleKey: plan.roleKey,
          mandateId: plan.mandateId,
          simulated: txHash === null,
        },
      })
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['invoice', invoiceId] })
      await queryClient.invalidateQueries({ queryKey: ['invoices'] })
      setPhase('done')
      onOpenChange(false)
      toast.success('Beneficiary registered · payout queued')
    },
    onError: (error) => {
      setPhase('review')
      toast.error(error.message)
    },
  })

  const canSign = Boolean(plan?.signable && plan.safeTx && plan.safeAddress && isConnected && address)

  function handleSubmit(event: FormEvent) {
    event.preventDefault()
    prepare.mutate(form)
  }

  async function handleSign() {
    if (!plan) return
    if (!canSign || !plan.safeTx || !plan.safeAddress || !address || !publicClient) {
      finish.mutate(null)
      return
    }
    setPhase('signing')
    try {
      const call = buildExecTransactionCall(getAddress(plan.safeAddress), address as Address, {
        to: plan.safeTx.to,
        value: BigInt(plan.safeTx.value),
        data: plan.safeTx.data,
        operation: plan.safeTx.operation,
      })
      const hash = await writeContractAsync({ ...call, chainId: SEPOLIA_CHAIN_ID })
      toast.message('Transaction sent', { description: hash })
      const receipt = await publicClient.waitForTransactionReceipt({ hash })
      if (receipt.status !== 'success') throw new Error('Safe transaction reverted')
      finish.mutate(hash)
    } catch (error) {
      setPhase('review')
      toast.error(error instanceof Error ? error.message : String(error))
    }
  }

  function handleSimulate() {
    finish.mutate(null)
  }

  function handleBack() {
    setPhase('form')
  }

  function toggleCalls() {
    setShowCalls((v) => !v)
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
              <DialogDescription>Confirm the payee from the invoice and set a monthly limit. The chain enforces it.</DialogDescription>
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
                <Input value={form.type} readOnly className="text-dim" />
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
              <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={prepare.isPending}>
                {prepare.isPending ? <LoaderCircle aria-hidden className="animate-spin" /> : null}
                Continue
              </Button>
            </DialogFooter>
          </form>
        ) : null}

        {(phase === 'review' || phase === 'signing' || phase === 'done') && plan ? (
          <div className="grid gap-5">
            <DialogHeader>
              <DialogTitle>Sign mandate</DialogTitle>
              <DialogDescription>{plan.reason}</DialogDescription>
            </DialogHeader>
            <div className="flex flex-wrap gap-1.5">
              <Chip variant="chain">{plan.payees.length} payee{plan.payees.length === 1 ? '' : 's'}</Chip>
              <Chip variant="chain">≤ {formatEur(form.monthlyLimitEur)}/mo</Chip>
              <Chip variant="chain">EURC</Chip>
              <Chip variant="agent">invoice approved</Chip>
              <Chip variant="agent">sanctions check</Chip>
            </div>
            <div className="grid grid-cols-2 gap-6">
              <div>
                <h3 className="mb-3 text-xs text-dim">Can</h3>
                {plan.can.map((line) => (
                  <div key={line} className="my-2.5 flex items-center gap-2 text-xs text-secondary-foreground">
                    <Check aria-hidden className="size-3.5 text-sage" />
                    {line}
                  </div>
                ))}
              </div>
              <div>
                <h3 className="mb-3 text-xs text-dim">Can’t</h3>
                {plan.cant.map((line) => (
                  <div key={line} className="my-2.5 flex items-center gap-2 text-xs text-secondary-foreground">
                    <X aria-hidden className="size-3.5 text-dim" />
                    {line}
                  </div>
                ))}
              </div>
            </div>
            <div className="border-y border-hairline py-3 text-xs text-dim">
              <button type="button" onClick={toggleCalls} className="flex items-center gap-1.5">
                <ChevronRight aria-hidden className={cn('size-3 transition-transform', showCalls && 'rotate-90')} />
                {plan.calls.length} call{plan.calls.length === 1 ? '' : 's'} · {plan.mode === 'install' ? 'install Roles module' : plan.mode === 'add_payee' ? 'add payee' : 'no chain change'}
              </button>
              {showCalls ? (
                <ol className="mt-3 ml-5 grid gap-1 font-mono text-xs leading-relaxed">
                  {plan.calls.map((c, i) => (
                    <li key={c}>
                      {i + 1} · {c}
                    </li>
                  ))}
                  {plan.rolesProxy ? (
                    <li className="text-dim">
                      Roles proxy <AddressMono value={plan.rolesProxy} copy={false} />
                    </li>
                  ) : null}
                </ol>
              ) : null}
            </div>
            <div className="flex items-center justify-between text-xs text-dim">
              <span>Signer</span>
              <span className="font-mono">{address ? <AddressMono value={address} link={false} /> : 'no wallet connected'}</span>
            </div>
            <div className="flex items-center justify-between text-xs text-dim">
              <span>Safe</span>
              <span className="font-mono">{plan.safeAddress ? <AddressMono value={plan.safeAddress} /> : 'not configured'}</span>
            </div>
            <ChipLegend className="justify-end" />
            <DialogFooter>
              <Button type="button" variant="secondary" onClick={handleBack} disabled={phase === 'signing' || finish.isPending}>
                Back
              </Button>
              {canSign ? (
                <Button type="button" onClick={handleSign} disabled={phase === 'signing' || finish.isPending}>
                  {phase === 'signing' || finish.isPending ? <LoaderCircle aria-hidden className="animate-spin" /> : null}
                  Sign
                </Button>
              ) : (
                <Button type="button" onClick={handleSimulate} disabled={finish.isPending}>
                  {finish.isPending ? <LoaderCircle aria-hidden className="animate-spin" /> : null}
                  Simulate signature
                </Button>
              )}
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
