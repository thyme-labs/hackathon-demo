import { createServerFn } from '@tanstack/react-start'
import type { AgentView, ExecutableResult } from './dto'

export const listAgents = createServerFn({ method: 'GET', strict: false }).handler(async (): Promise<AgentView[]> => {
  const { ensureBooted } = await import('./boot')
  ensureBooted()
  const { agents, audit, invoices, beneficiaries, payouts } = await import('../store/repos')
  const { parseChecklist } = await import('../agent/checklist')
  const { serverEnv } = await import('../env')
  const { resolveExecutionMode } = await import('../payments/runner')
  const { buildOnboardingView } = await import('./thymeOnboarding')
  const { readAutoPaySettings } = await import('./autopay')
  const autoPaySettings = readAutoPaySettings()
  const autoPay = { threshold: autoPaySettings.threshold, enabled: autoPaySettings.enabled }

  let cost = 0
  let calls = 0
  for (const i of invoices.list({ limit: 1000 })) {
    const snap = parseChecklist(i.checklist_json)
    cost += snap.llm.cost_usd
    calls += snap.llm.calls
  }
  const active = beneficiaries.list('active')
  const paid = payouts.paidThisMonthByBeneficiary()
  const limit = active.reduce((s, b) => s + b.monthly_limit_eur, 0)
  const used = active.reduce((s, b) => s + (paid[b.id] ?? 0), 0)
  const executor = serverEnv.paymentExecutor()
  const execution = await resolveExecutionMode(executor)
  const onboarding = buildOnboardingView()
  const events = audit.list({ limit: 400 })

  return agents.list().map((a) => {
    let config: Record<string, unknown> = {}
    try {
      config = a.config_json ? (JSON.parse(a.config_json) as Record<string, unknown>) : {}
    } catch {
      config = {}
    }
    const runs = events.filter((e) => (a.kind === 'compliance' ? e.event.startsWith('invoice.') || e.event.startsWith('investigation.') : e.event.startsWith('payout.') || e.event.startsWith('thyme.'))).slice(0, 25)
    return {
      ...a,
      config,
      cost_usd: a.kind === 'compliance' ? Math.round(cost * 1e4) / 1e4 : 0,
      llm_calls: a.kind === 'compliance' ? calls : 0,
      runs,
      executor,
      execution,
      thyme: {
        triggerMode: onboarding.triggerMode,
        onboarded: onboarding.onboarded,
        simulated: onboarding.simulated,
        safeAddress: onboarding.safeAddress,
        profileId: onboarding.profileId,
        profileStatus: onboarding.profileStatus,
        executableId: onboarding.executableId,
        executableStatus: onboarding.executableStatus,
        executablePausedReason: onboarding.executablePausedReason,
        hasWebhook: onboarding.hasWebhook,
        lastExecutionId: onboarding.lastExecutionId,
        rolesProxy: onboarding.rolesProxy,
        executorSafe: onboarding.executorSafe,
      },
      payees: active.length,
      limit_eur: limit,
      used_eur: used,
      autoPay,
    }
  })
})

export interface ToggleAgentResult {
  id: string
  status: 'running' | 'paused'
  /** Kill switch result at Thyme for the payment agent: the executable is paused / resumed through the API. */
  thyme: { applied: boolean; message: string } | null
}

export const toggleAgent = createServerFn({ method: 'POST' })
  .validator((input: { id: string }) => input)
  .handler(async ({ data }): Promise<ToggleAgentResult> => {
    const { agents, appendAudit } = await import('../store/repos')
    const { setExecutablePaused } = await import('./thymeOnboarding')
    const agent = agents.get(data.id)
    if (!agent) throw new Error('agent not found')
    const next = agent.status === 'running' ? 'paused' : 'running'
    agents.setStatus(agent.id, next)
    appendAudit({ actor: 'owner', event: next === 'paused' ? 'agent.paused' : 'agent.resumed', details: { agent: agent.id } })
    const thyme = agent.kind === 'payment' ? await setExecutablePaused(next === 'paused') : null
    return { id: agent.id, status: next, thyme }
  })

/** "Re-sync executable": re-read the executable status from Thyme; throws a readable error (code, requestId) on failure. */
export const refreshThymeExecutable = createServerFn({ method: 'POST' }).handler(async (): Promise<ExecutableResult> => {
  const { resyncExecutable } = await import('./thymeOnboarding')
  return resyncExecutable()
})

export interface RunPaymentAgentResult {
  /** Payouts the agent handled in this pass. */
  handled: number
  /** Pending payouts left for the next pass (e.g. recently handed to Thyme). */
  pending: number
  paused: boolean
}

/** "Run payment agent now": one pass of runPaymentsOnce (respects the pause switch and the lock). Safe to click twice. */
export const runPaymentAgentNow = createServerFn({ method: 'POST' }).handler(async (): Promise<RunPaymentAgentResult> => {
  const { ensureBooted } = await import('./boot')
  ensureBooted()
  const { agents, payouts } = await import('../store/repos')
  const { runPaymentsOnce } = await import('../payments/runner')
  const agent = agents.get('payment')
  const paused = Boolean(agent && agent.status !== 'running')
  const handled = paused ? 0 : await runPaymentsOnce()
  return { handled, pending: payouts.list({ status: 'pending', limit: 100 }).length, paused }
})
