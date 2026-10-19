import { createServerFn } from '@tanstack/react-start'
import type { AgentView } from './dto'

export const listAgents = createServerFn({ method: 'GET', strict: false }).handler(async (): Promise<AgentView[]> => {
  const { ensureBooted } = await import('./boot')
  ensureBooted()
  const { agents, audit, invoices, beneficiaries, payouts } = await import('../store/repos')
  const { parseChecklist } = await import('../agent/checklist')
  const { serverEnv } = await import('../env')
  const { resolveExecutionMode } = await import('../payments/runner')
  const { buildOnboardingView } = await import('./thymeOnboarding')

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

/** Re-read the executable status from Thyme (agents page refresh). */
export const refreshThymeExecutable = createServerFn({ method: 'POST' }).handler(async (): Promise<{ status: string | null; pausedReason: string | null }> => {
  const { refreshExecutable } = await import('./thymeOnboarding')
  const executable = await refreshExecutable()
  return { status: executable?.status ?? null, pausedReason: executable?.pausedReason ?? null }
})
