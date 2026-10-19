import { createServerFn } from '@tanstack/react-start'
import type { ActivityItem, DashboardView } from './dto'

const BALANCE_TIMEOUT_MS = 6_000

export const getDashboard = createServerFn({ method: 'GET' }).handler(async (): Promise<DashboardView> => {
  const { ensureBooted } = await import('./boot')
  ensureBooted()
  const { agents, dashboardCounts, beneficiaries, payouts, invoices, audit, settings } = await import('../store/repos')
  const { serverEnv } = await import('../env')
  const { resolveExecutionMode } = await import('../payments/runner')
  const { buildOnboardingView } = await import('./thymeOnboarding')
  const { agentEnv } = await import('../agent/env')
  const { buildComparisonCard } = await import('../reports/comparison')

  const all = settings.all()
  const safeAddress = all.safeAddress ?? null
  const onboarding = buildOnboardingView()
  const counts = dashboardCounts()
  const active = beneficiaries.list('active')
  const paidByBen = payouts.paidThisMonthByBeneficiary()
  const limit = active.reduce((s, b) => s + b.monthly_limit_eur, 0)
  const used = active.reduce((s, b) => s + (paidByBen[b.id] ?? 0), 0)

  let balances: DashboardView['balances'] = null
  let balancesError: string | null = null
  const target = safeAddress
  if (target && !agentEnv.offline()) {
    try {
      const { getPublicClient } = await import('../chain/clients')
      const { readBalances } = await import('../chain/balances')
      const { getAddress } = await import('viem')
      const result = await Promise.race([
        readBalances(getPublicClient(), getAddress(target)),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('RPC timeout')), BALANCE_TIMEOUT_MS)),
      ])
      balances = { eth: result.formatted.eth, eurc: result.formatted.eurc, usdc: result.formatted.usdc, blockNumber: result.blockNumber.toString(), address: result.address }
    } catch (error) {
      balancesError = error instanceof Error ? error.message : String(error)
    }
  } else if (!target) {
    balancesError = 'No Safe yet: enable payroll to pick one'
  }

  const inv = new Map(invoices.list({ limit: 500 }).map((i) => [i.id, i]))
  const ben = new Map(beneficiaries.list().map((b) => [b.id, b]))
  const activity: ActivityItem[] = []
  for (const e of audit.list({ limit: 300 })) {
    const invoice = e.invoice_id ? inv.get(e.invoice_id) : undefined
    const who = (e.beneficiary_id ? ben.get(e.beneficiary_id)?.name : undefined) ?? invoice?.payee_name ?? 'unknown payee'
    let details: Record<string, unknown> = {}
    try {
      details = e.details_json ? (JSON.parse(e.details_json) as Record<string, unknown>) : {}
    } catch {
      details = {}
    }
    const txHash = typeof details.tx_hash === 'string' ? details.tx_hash : null
    const simulated = details.simulated === true
    const amount = typeof details.amount_eur === 'number' ? details.amount_eur : (invoice?.amount_eur ?? null)
    const base = { id: String(e.id), ts: e.ts, tx_hash: txHash, simulated, invoice_id: e.invoice_id }
    switch (e.event) {
      case 'payout.confirmed':
        activity.push({ ...base, kind: 'paid', text: `Paid ${who} · ${invoice?.number ?? ''}`.trim(), amount_eur: amount })
        break
      case 'payout.reverted':
      case 'payout.failed':
        activity.push({ ...base, kind: 'blocked', text: `Blocked · ${who} · ${invoice?.number ?? ''} · ${e.event === 'payout.reverted' ? 'reverted on chain' : 'failed'}`, amount_eur: amount })
        break
      case 'invoice.rejected':
        activity.push({ ...base, kind: 'rejected', text: `Stopped · ${who} · ${invoice?.number ?? ''}`, amount_eur: amount })
        break
      case 'invoice.needs_approval':
        activity.push({ ...base, kind: 'held', text: `Held for approval · ${who} · ${invoice?.number ?? ''}`, amount_eur: amount })
        break
      case 'beneficiary.activated':
        activity.push({ ...base, kind: 'registered', text: `Registered ${who} · limit €${Number(details.monthly_limit_eur ?? 0).toLocaleString('en-IE')}/mo`, amount_eur: null })
        break
      case 'invoice.uploaded':
        activity.push({ ...base, kind: 'uploaded', text: `Invoice received · ${String(details.name ?? '')}`, amount_eur: null })
        break
      case 'thyme.profile_active':
        activity.push({ ...base, kind: 'registered', text: 'Payroll enabled on the Safe · Thyme Roles profile active', amount_eur: null })
        break
      case 'thyme.onboarded':
        activity.push({ ...base, kind: 'registered', text: 'Thyme executable + webhook ready', amount_eur: null })
        break
      case 'thyme.onboarding_simulated':
        activity.push({ ...base, kind: 'info', text: 'Onboarding simulated (no wallet, no Thyme)', amount_eur: null })
        break
      case 'thyme.executable_paused':
        activity.push({ ...base, kind: 'held', text: 'Kill switch · Thyme executable paused', amount_eur: null })
        break
      case 'agent.paused':
        activity.push({ ...base, kind: 'held', text: `Agent paused · ${String(details.agent ?? '')}`, amount_eur: null })
        break
      default:
        break
    }
    if (activity.length >= 12) break
  }

  let comparison: DashboardView['comparison'] = null
  try {
    const items = payouts
      .list({ limit: 500 })
      .filter((p) => p.status === 'confirmed')
      .map((p) => ({ payout: p, country: (p.beneficiary_id ? ben.get(p.beneficiary_id)?.country : null) ?? 'XX', fee: p.simulated ? { gasUsed: p.gas_used, effectiveGasPriceWei: 0, feeEth: 0, feeEur: 0 } : { gasUsed: p.gas_used, effectiveGasPriceWei: p.effective_gas_price_wei }, invoiceNumber: inv.get(p.invoice_id)?.number ?? null, beneficiaryName: p.beneficiary_id ? (ben.get(p.beneficiary_id)?.name ?? null) : null }))
    const card = buildComparisonCard(items)
    comparison = { headline: card.headline, subline: card.subline, savedEur: card.savedEur, savedBusinessDays: card.savedBusinessDays, payouts: card.confirmed, totalEur: card.totalEur, periodLabel: card.periodLabel }
  } catch {
    comparison = null
  }

  const execution = await resolveExecutionMode(serverEnv.paymentExecutor())
  return {
    safeAddress,
    balances,
    balancesError,
    counts,
    agents: agents.list().map((a) => ({
      id: a.id,
      name: a.name,
      kind: a.kind,
      status: a.status,
      used_eur: a.kind === 'payment' ? used : 0,
      limit_eur: a.kind === 'payment' ? limit : 0,
      chips:
        a.kind === 'payment'
          ? [
              { variant: 'chain' as const, label: 'EURC only' },
              { variant: 'chain' as const, label: 'transfer only' },
              { variant: 'chain' as const, label: 'this Safe via Thyme' },
              { variant: 'agent' as const, label: `${active.length} payee${active.length === 1 ? '' : 's'} · limits` },
              { variant: 'agent' as const, label: execution.mode === 'thyme' ? 'Thyme Flow' : 'simulated' },
            ]
          : [
              { variant: 'agent' as const, label: 'sanctions' },
              { variant: 'agent' as const, label: 'wallet on file' },
              { variant: 'agent' as const, label: 'issuer backing' },
              { variant: 'agent' as const, label: `auto-pay ≥ ${serverEnv.autoPayThreshold()}` },
            ],
    })),
    activity,
    comparison,
    execution,
    onboarding: { ready: onboarding.ready, onboarded: onboarding.onboarded, simulated: onboarding.simulated, configured: onboarding.configured, step: onboarding.step },
  }
})
