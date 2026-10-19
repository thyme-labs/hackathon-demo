// Server-only payment agent: turns `pending` payouts into chain transactions.
//   direct  -> the agent EOA calls execTransactionWithRole on our Roles module (src/lib/chain/agentSigner.ts)
//   thyme   -> triggers the Thyme Flow executable and waits for the callback
//   neither configured (no AGENT_PRIVATE_KEY / no Roles module in settings) -> the payout is recorded as
//   `simulated` with a labelled placeholder hash so the whole flow still runs in mock mode.
import { type Address, getAddress, type Hex, isAddress, keccak256, toHex } from 'viem'
import { serverEnv } from '../env'
import { appendAudit, beneficiaries, invoices, nowIso, payouts, settings } from '../store/repos'
import type { Invoice, Payout } from '../store/types'

if (typeof window !== 'undefined') {
  throw new Error('src/lib/payments/runner.ts is server-only')
}

export const SIMULATED_GAS_USED = 140_000
const SIMULATED_DELAY_MS = 1_800

export interface MandateSettings {
  safeAddress: Address | null
  rolesProxy: Address | null
  roleKey: Hex | null
  mandateId: string | null
  agentAddress: Address | null
}

const addr = (v: string | null): Address | null => (v && isAddress(v) ? getAddress(v) : null)

export function readMandate(): MandateSettings {
  const all = settings.all()
  return {
    safeAddress: addr(all.safeAddress ?? null),
    rolesProxy: addr(all.rolesProxy ?? null),
    roleKey: (all.roleKey as Hex | undefined) ?? null,
    mandateId: all.mandateId ?? null,
    agentAddress: addr(all.agentAddress ?? null),
  }
}

export type ExecutionMode = 'direct' | 'thyme' | 'simulated'

/** Which path a payout would take right now. */
export async function resolveExecutionMode(executor: Payout['executor']): Promise<{ mode: ExecutionMode; reason: string }> {
  if (executor === 'thyme') {
    const { getThymeTriggerMode } = await import('../thyme/env')
    const trigger = getThymeTriggerMode()
    if (trigger !== 'none') return { mode: 'thyme', reason: `Thyme Flow (${trigger})` }
    return { mode: 'simulated', reason: 'THYME_PAY_WEBHOOK_URL / THYME_API_KEY not configured' }
  }
  const { getAgentAddress } = await import('../chain/agentSigner')
  const agent = getAgentAddress()
  const mandate = readMandate()
  if (!agent) return { mode: 'simulated', reason: 'AGENT_PRIVATE_KEY not configured' }
  if (!mandate.rolesProxy || !mandate.roleKey) return { mode: 'simulated', reason: 'Roles module not installed (settings.rolesProxy / roleKey empty)' }
  return { mode: 'direct', reason: `agent ${agent} via Roles ${mandate.rolesProxy}` }
}

export function simulatedTxHash(seed: string): Hex {
  return keccak256(toHex(`thyme-payroll:simulated:${seed}`))
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface SettleInput {
  payout: Payout
  invoice: Invoice
  status: 'confirmed' | 'reverted' | 'failed'
  txHash: Hex | null
  blockNumber: number | null
  gasUsed: number | null
  effectiveGasPriceWei: string | null
  error: string | null
  simulated: boolean
  executionId?: string | null
  thymeExecutionId?: string
}

function settle(input: SettleInput): Payout {
  const ts = nowIso()
  const updated = payouts.setStatus(input.payout.id, input.status, {
    tx_hash: input.txHash,
    block_number: input.blockNumber,
    gas_used: input.gasUsed,
    effective_gas_price_wei: input.effectiveGasPriceWei,
    error: input.error,
    confirmed_at: input.status === 'confirmed' ? ts : null,
    simulated: input.simulated ? 1 : 0,
    thyme_execution_id: input.executionId ?? input.payout.thyme_execution_id,
  }) as Payout
  if (input.status === 'confirmed') {
    invoices.setStatus(input.invoice.id, 'paid')
    if (input.payout.beneficiary_id) beneficiaries.recordPaid(input.payout.beneficiary_id, input.payout.amount_eur, ts)
  } else {
    invoices.setStatus(input.invoice.id, 'failed', { decision_text: `${input.invoice.decision_text ?? ''}\n\nPayment ${input.status}: ${input.error ?? 'unknown error'}`.trim() })
  }
  appendAudit({
    actor: input.simulated ? 'agent' : 'chain',
    event: `payout.${input.status}`,
    invoiceId: input.invoice.id,
    beneficiaryId: input.payout.beneficiary_id,
    details: {
      payout_id: input.payout.id,
      amount_eur: input.payout.amount_eur,
      amount_eurc: input.payout.amount_eurc,
      tx_hash: input.txHash,
      block_number: input.blockNumber,
      gas_used: input.gasUsed,
      error: input.error,
      simulated: input.simulated,
      executor: input.payout.executor,
      thyme_execution_id: input.thymeExecutionId ?? null,
    },
  })
  return updated
}

/** Execute one pending payout to the beneficiary wallet ON FILE. Returns the settled row. */
export async function executeOnePayout(payoutId: string, opts: { force?: boolean; to?: Address } = {}): Promise<Payout> {
  const payout = payouts.get(payoutId)
  if (!payout) throw new Error(`payout ${payoutId} not found`)
  if (payout.status !== 'pending') return payout
  const invoice = invoices.get(payout.invoice_id)
  if (!invoice) throw new Error(`invoice ${payout.invoice_id} not found`)
  const beneficiary = payout.beneficiary_id ? beneficiaries.get(payout.beneficiary_id) : null
  const to = opts.to ?? addr(beneficiary?.wallet ?? null)
  if (!to) {
    return settle({ payout, invoice, status: 'failed', txHash: null, blockNumber: null, gasUsed: null, effectiveGasPriceWei: null, error: 'beneficiary has no wallet on file', simulated: false })
  }

  const { mode, reason } = await resolveExecutionMode(payout.executor)
  const ts = nowIso()
  payouts.setStatus(payout.id, 'submitted', { submitted_at: ts })
  invoices.setStatus(invoice.id, 'paying')
  appendAudit({
    actor: 'agent',
    event: 'payout.submitted',
    invoiceId: invoice.id,
    beneficiaryId: payout.beneficiary_id,
    details: { payout_id: payout.id, to, amount_eurc: payout.amount_eurc, mode, reason, force: opts.force ?? false },
  })
  const submitted = payouts.get(payout.id) as Payout

  if (mode === 'simulated') {
    await sleep(SIMULATED_DELAY_MS)
    if (opts.force) {
      return settle({
        payout: submitted,
        invoice,
        status: 'reverted',
        txHash: simulatedTxHash(`${payout.id}:reverted`),
        blockNumber: null,
        gasUsed: 88_000,
        effectiveGasPriceWei: null,
        error: `ConditionViolation(OrViolation): ${to} is not an allowed recipient under the Roles mandate; the chain would revert this transfer (simulated, ${reason})`,
        simulated: true,
      })
    }
    return settle({
      payout: submitted,
      invoice,
      status: 'confirmed',
      txHash: simulatedTxHash(payout.id),
      blockNumber: null,
      gasUsed: SIMULATED_GAS_USED,
      effectiveGasPriceWei: null,
      error: null,
      simulated: true,
    })
  }

  const mandate = readMandate()
  const { executePayout } = await import('../thyme/executor')
  try {
    const result = await executePayout(
      { payoutId: payout.id, invoiceId: invoice.id, payee: to, amountEurcUnits: BigInt(payout.amount_eurc) },
      {
        executor: mode,
        rolesProxy: mandate.rolesProxy ?? undefined,
        roleKey: mandate.roleKey ?? undefined,
        safeAddress: mandate.safeAddress ?? undefined,
        direct: { preflight: true, forceOnRevert: true },
        appUrl: serverEnv.appUrl(),
      },
    )
    const raw = result.raw as { blockNumber?: bigint; effectiveGasPrice?: bigint } | undefined
    const status = result.status === 'confirmed' ? 'confirmed' : result.status === 'reverted' ? 'reverted' : result.status === 'submitted' || result.status === 'pending' ? null : 'failed'
    if (status === null) {
      // Thyme accepted the run but has not settled yet; the webhook (/api/webhooks/thyme) finishes it.
      payouts.update(payout.id, { thyme_execution_id: result.thymeExecutionId ?? null, tx_hash: result.txHash ?? null })
      return payouts.get(payout.id) as Payout
    }
    return settle({
      payout: submitted,
      invoice,
      status,
      txHash: result.txHash ?? null,
      blockNumber: result.blockNumber ?? (raw?.blockNumber !== undefined ? Number(raw.blockNumber) : null),
      gasUsed: result.gasUsed ? Number(result.gasUsed) : null,
      effectiveGasPriceWei: raw?.effectiveGasPrice !== undefined ? String(raw.effectiveGasPrice) : null,
      error: status === 'confirmed' ? null : (result.error ?? `execution ${result.status}`),
      simulated: false,
      thymeExecutionId: result.thymeExecutionId,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return settle({ payout: submitted, invoice, status: 'failed', txHash: null, blockNumber: null, gasUsed: null, effectiveGasPriceWei: null, error: message, simulated: false })
  }
}

const lock = { busy: false }

/** Process every pending payout once (skipped while the payment agent is paused). Returns settled count. */
export async function runPaymentsOnce(): Promise<number> {
  if (lock.busy) return 0
  lock.busy = true
  try {
    const { agents } = await import('../store/repos')
    const agent = agents.get('payment')
    if (agent && agent.status !== 'running') return 0
    const pending = payouts.listPending()
    let n = 0
    for (const p of pending) {
      await executeOnePayout(p.id)
      n += 1
    }
    if (n > 0) agents.touch('payment')
    return n
  } finally {
    lock.busy = false
  }
}

/**
 * "Force" demo path: what a fooled agent would do with a rejected invoice, i.e. pay the wallet printed on the PDF.
 * With a real key the Roles module reverts on chain (ConditionViolation); without one the revert is simulated.
 */
export async function forcePayout(invoiceId: string): Promise<Payout> {
  const invoice = invoices.get(invoiceId)
  if (!invoice) throw new Error('invoice not found')
  const to = addr(invoice.payee_wallet)
  if (!to) throw new Error('invoice has no wallet to pay')
  const amountEur = Math.round((invoice.amount_eur ?? invoice.amount ?? 0) * 100) / 100
  const { parseUnits } = await import('viem')
  const payout = payouts.create({
    invoice_id: invoice.id,
    beneficiary_id: invoice.beneficiary_id,
    amount_eurc: parseUnits(amountEur.toFixed(6), 6).toString(),
    amount_eur: amountEur,
    currency: invoice.currency ?? 'EUR',
    fx_rate: invoice.fx_rate ?? 1,
    executor: serverEnv.paymentExecutor(),
    status: 'pending',
  })
  appendAudit({ actor: 'owner', event: 'payout.forced', invoiceId: invoice.id, beneficiaryId: invoice.beneficiary_id, details: { payout_id: payout.id, to, note: 'owner forced a rejected invoice; the chain decides' } })
  const before = invoice.status
  const settled = await executeOnePayout(payout.id, { force: true, to })
  // A rejected invoice stays rejected: the chain refusal is the point of the demo.
  if (before === 'rejected') invoices.setStatus(invoice.id, 'rejected')
  return settled
}
