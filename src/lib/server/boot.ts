// Process-wide boot: plug the chain readers into the agent service and start the in-process loops
// (compliance queue + payment agent). Guarded on globalThis so SSR, dev HMR and the Nitro worker only ever
// run one set of timers. Every tick walks the tenants that have work and runs each inside its tenant context,
// so the agents read that tenant's settings (Thyme ids, auto-pay, Safe).
import { CHECKS } from '../agent/checks'
import { serverEnv } from '../env'
import { agents, forTenant, listTenantsWithWork } from '../store/repos'
import { runWithTenant } from '../store/tenant'

if (typeof window !== 'undefined') {
  throw new Error('src/lib/server/boot.ts is server-only')
}

interface BootState {
  startedAt: string
  timer: ReturnType<typeof setInterval> | null
  ticking: boolean
  lastTickAt: string | null
  lastError: string | null
}

const KEY = '__thymePayrollBoot'
const g = globalThis as typeof globalThis & { [KEY]?: BootState; __thymePayrollSeeded?: Set<string> }

export const AGENT_IDS = { compliance: 'compliance', payment: 'payment' } as const
const TICK_MS = 3_000

/** The two agent rows of one tenant; keeps a paused status. */
export function seedAgents(tenant: string): void {
  const provider = serverEnv.llmProvider()
  const models =
    provider === 'bedrock'
      ? { extract: process.env.BEDROCK_MODEL_EXTRACT ?? 'eu.anthropic.claude-haiku-4-5-20251001-v1:0', reason: process.env.BEDROCK_MODEL_REASON ?? 'eu.anthropic.claude-sonnet-4-5-20250929-v1:0' }
      : provider === 'anthropic'
        ? { extract: process.env.ANTHROPIC_MODEL_EXTRACT ?? 'claude-haiku-4-5', reason: process.env.ANTHROPIC_MODEL_REASON ?? 'claude-sonnet-4-5' }
        : { extract: 'mock/extract', reason: 'mock/reason' }
  const repo = forTenant(tenant).agents
  const existingCompliance = repo.get(AGENT_IDS.compliance)
  repo.upsert({
    id: AGENT_IDS.compliance,
    name: 'Compliance agent',
    kind: 'compliance',
    status: existingCompliance?.status ?? 'running',
    config_json: JSON.stringify({ provider, models, auto_pay_threshold: serverEnv.autoPayThreshold(), checks: CHECKS.length }),
  })
  const existingPayment = repo.get(AGENT_IDS.payment)
  repo.upsert({
    id: AGENT_IDS.payment,
    name: 'Payment agent',
    kind: 'payment',
    status: existingPayment?.status ?? 'running',
    config_json: JSON.stringify({ executor: serverEnv.paymentExecutor(), rail: 'Thyme Flow', token: 'EURC', chain: 'sepolia' }),
  })
}

/** Lazy per-tenant seed: the first request of a tenant creates its two agents. Idempotent, cheap after the first call. */
export function ensureTenantSeeded(tenant: string): void {
  ensureBooted()
  const seeded = (g.__thymePayrollSeeded ??= new Set<string>())
  if (seeded.has(tenant)) return
  seedAgents(tenant)
  seeded.add(tenant)
}

async function configureService(): Promise<void> {
  // Per-beneficiary limits are enforced by the agent (checks/budget.ts + payments/runner.ts); the chain
  // only guarantees EURC.transfer from the Safe through Thyme, so there is no on-chain allowance to read.
  const { configureAgentService } = await import('../agent/service')
  configureAgentService({})
}

/** One pass for the tenant of the current context: compliance queue (unless paused), then the payment agent. */
async function tickTenant(): Promise<{ investigated: string | null; payouts: number }> {
  const { runQueueOnce } = await import('../agent/service')
  const { runPaymentsOnce } = await import('../payments/runner')
  const compliance = agents.get(AGENT_IDS.compliance)
  let investigated: string | null = null
  if (!compliance || compliance.status === 'running') {
    const result = await runQueueOnce()
    investigated = result?.invoice.id ?? null
    if (result) agents.touch(AGENT_IDS.compliance)
  }
  const n = await runPaymentsOnce()
  return { investigated, payouts: n }
}

async function tick(state: BootState): Promise<void> {
  if (state.ticking) return
  state.ticking = true
  try {
    state.lastTickAt = new Date().toISOString()
    const errors: string[] = []
    for (const tenant of listTenantsWithWork()) {
      // Per tenant: a tenant whose Thyme config or queue throws must not block the tenants after it.
      try {
        ensureTenantSeeded(tenant)
        await runWithTenant(tenant, tickTenant)
      } catch (error) {
        errors.push(`${tenant}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    state.lastError = errors.length > 0 ? errors.join(' | ') : null
  } catch (error) {
    state.lastError = error instanceof Error ? error.message : String(error)
  } finally {
    state.ticking = false
  }
}

/** Idempotent. Call from any server entry point (root loader, API routes). */
export function ensureBooted(): BootState {
  if (g[KEY]) return g[KEY]
  const state: BootState = { startedAt: new Date().toISOString(), timer: null, ticking: false, lastTickAt: null, lastError: null }
  g[KEY] = state
  void configureService().catch((error: unknown) => {
    state.lastError = error instanceof Error ? error.message : String(error)
  })
  state.timer = setInterval(() => void tick(state), TICK_MS)
  // Do not keep the process alive for the loop alone (scripts, tests).
  const t = state.timer as unknown as { unref?: () => void }
  t.unref?.()
  return state
}

export function bootStatus(): Omit<BootState, 'timer'> & { running: boolean } {
  const s = ensureBooted()
  return { startedAt: s.startedAt, ticking: s.ticking, lastTickAt: s.lastTickAt, lastError: s.lastError, running: s.timer !== null }
}

/** Run the compliance queue and the payment agent once for the current tenant, right now (the "Run now" button). */
export async function runOnce(): Promise<{ investigated: string | null; payouts: number }> {
  ensureBooted()
  return tickTenant()
}
