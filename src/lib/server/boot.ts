// Process-wide boot: seed the two agents, plug the chain readers into the agent service and start the
// in-process loops (compliance queue + payment agent). Guarded on globalThis so SSR, dev HMR and the
// Nitro worker only ever run one set of timers.
import { serverEnv } from '../env'
import { agents, settings } from '../store/repos'

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
const g = globalThis as typeof globalThis & { [KEY]?: BootState }

export const AGENT_IDS = { compliance: 'compliance', payment: 'payment' } as const
const TICK_MS = 3_000

export function seedAgents(): void {
  const provider = serverEnv.llmProvider()
  const models =
    provider === 'bedrock'
      ? { extract: process.env.BEDROCK_MODEL_EXTRACT ?? 'eu.anthropic.claude-haiku-4-5-20251001-v1:0', reason: process.env.BEDROCK_MODEL_REASON ?? 'eu.anthropic.claude-sonnet-4-5-20250929-v1:0' }
      : provider === 'anthropic'
        ? { extract: process.env.ANTHROPIC_MODEL_EXTRACT ?? 'claude-haiku-4-5', reason: process.env.ANTHROPIC_MODEL_REASON ?? 'claude-sonnet-4-5' }
        : { extract: 'mock/extract', reason: 'mock/reason' }
  const existingCompliance = agents.get(AGENT_IDS.compliance)
  agents.upsert({
    id: AGENT_IDS.compliance,
    name: 'Compliance agent',
    kind: 'compliance',
    status: existingCompliance?.status ?? 'running',
    config_json: JSON.stringify({ provider, models, auto_pay_threshold: serverEnv.autoPayThreshold(), checks: 12 }),
  })
  const existingPayment = agents.get(AGENT_IDS.payment)
  agents.upsert({
    id: AGENT_IDS.payment,
    name: 'Payment agent',
    kind: 'payment',
    status: existingPayment?.status ?? 'running',
    config_json: JSON.stringify({ executor: serverEnv.paymentExecutor(), token: 'EURC', chain: 'sepolia', executable_id: process.env.THYME_EXECUTABLE_ID ?? null }),
  })
}

async function configureService(): Promise<void> {
  const { configureAgentService } = await import('../agent/service')
  const { agentEnv } = await import('../agent/env')
  const offline = agentEnv.offline()
  configureAgentService({
    readAllowance: async (beneficiary) => {
      if (offline || !beneficiary.wallet) return null
      const rolesProxy = settings.get('rolesProxy')
      const roleKey = settings.get('roleKey')
      if (!rolesProxy || !roleKey) return null
      const { getPublicClient } = await import('../chain/clients')
      const { remainingFor, toAllowanceSnapshot } = await import('../roles/allowance')
      const { getAddress } = await import('viem')
      const budget = await remainingFor(getPublicClient(), {
        rolesProxy: getAddress(rolesProxy),
        roleKey: roleKey as `0x${string}`,
        wallet: getAddress(beneficiary.wallet),
      })
      return toAllowanceSnapshot(budget)
    },
  })
}

async function tick(state: BootState): Promise<void> {
  if (state.ticking) return
  state.ticking = true
  try {
    state.lastTickAt = new Date().toISOString()
    const compliance = agents.get(AGENT_IDS.compliance)
    if (!compliance || compliance.status === 'running') {
      const { runQueueOnce } = await import('../agent/service')
      const result = await runQueueOnce()
      if (result) agents.touch(AGENT_IDS.compliance)
    }
    const { runPaymentsOnce } = await import('../payments/runner')
    await runPaymentsOnce()
    state.lastError = null
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
  seedAgents()
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

/** Run the compliance queue and the payment agent once, right now (the "Run now" button). */
export async function runOnce(): Promise<{ investigated: string | null; payouts: number }> {
  ensureBooted()
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
