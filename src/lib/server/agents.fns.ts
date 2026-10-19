import { createServerFn } from '@tanstack/react-start'
import type { AgentView, MandatePlan } from './dto'

export const listAgents = createServerFn({ method: 'GET', strict: false }).handler(async (): Promise<AgentView[]> => {
  const { ensureBooted } = await import('./boot')
  ensureBooted()
  const { agents, audit, invoices, beneficiaries, payouts, settings } = await import('../store/repos')
  const { parseChecklist } = await import('../agent/checklist')
  const { serverEnv } = await import('../env')
  const { resolveExecutionMode } = await import('../payments/runner')
  const { getThymeTriggerMode, getThymeEnv } = await import('../thyme/env')
  const { resolveAgentAddress } = await import('./mandate')

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
  const thymeEnv = getThymeEnv()
  const triggerMode = getThymeTriggerMode(thymeEnv)
  const agentAddress = await resolveAgentAddress()
  const rolesProxy = settings.get('rolesProxy')
  const events = audit.list({ limit: 400 })

  return agents.list().map((a) => {
    let config: Record<string, unknown> = {}
    try {
      config = a.config_json ? (JSON.parse(a.config_json) as Record<string, unknown>) : {}
    } catch {
      config = {}
    }
    const runs = events.filter((e) => (a.kind === 'compliance' ? e.event.startsWith('invoice.') || e.event.startsWith('investigation.') : e.event.startsWith('payout.') || e.event.startsWith('mandate.'))).slice(0, 25)
    return {
      ...a,
      config,
      cost_usd: a.kind === 'compliance' ? Math.round(cost * 1e4) / 1e4 : 0,
      llm_calls: a.kind === 'compliance' ? calls : 0,
      runs,
      executor,
      execution,
      thyme: {
        triggerMode,
        executableId: thymeEnv.executableId ?? null,
        consoleUrl: thymeEnv.executableId ? `https://flow.thymelabs.io/executables/${thymeEnv.executableId}` : null,
      },
      agentAddress,
      rolesProxy,
      payees: active.length,
      limit_eur: limit,
      used_eur: used,
    }
  })
})

export interface ToggleAgentResult {
  id: string
  status: 'running' | 'paused'
  /** Kill switch / resume Safe tx when a mandate is installed and a Safe is configured. */
  plan: MandatePlan | null
}

export const toggleAgent = createServerFn({ method: 'POST' })
  .validator((input: { id: string }) => input)
  .handler(async ({ data }): Promise<ToggleAgentResult> => {
    const { agents, appendAudit } = await import('../store/repos')
    const { planAgentMembership } = await import('./mandate')
    const agent = agents.get(data.id)
    if (!agent) throw new Error('agent not found')
    const next = agent.status === 'running' ? 'paused' : 'running'
    agents.setStatus(agent.id, next)
    appendAudit({ actor: 'owner', event: next === 'paused' ? 'agent.paused' : 'agent.resumed', details: { agent: agent.id } })
    const plan = agent.kind === 'payment' ? await planAgentMembership(next === 'running') : null
    return { id: agent.id, status: next, plan }
  })

export const recordMembershipTx = createServerFn({ method: 'POST' })
  .validator((input: { member: boolean; txHash: string }) => input)
  .handler(async ({ data }) => {
    const { appendAudit, settings } = await import('../store/repos')
    settings.set(data.member ? 'resumeTxHash' : 'revokeTxHash', data.txHash)
    appendAudit({ actor: 'chain', event: data.member ? 'mandate.resumed' : 'mandate.revoked', details: { tx_hash: data.txHash } })
    return { ok: true }
  })
