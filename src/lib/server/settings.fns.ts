import { createServerFn } from '@tanstack/react-start'
import type { EnvStatusItem, SettingsView } from './dto'

const ENV_NAMES: { name: string; group: EnvStatusItem['group']; secret: boolean }[] = [
  { name: 'LLM_PROVIDER', group: 'llm', secret: false },
  { name: 'AWS_REGION', group: 'llm', secret: false },
  { name: 'BEDROCK_MODEL_EXTRACT', group: 'llm', secret: false },
  { name: 'BEDROCK_MODEL_REASON', group: 'llm', secret: false },
  { name: 'ANTHROPIC_API_KEY', group: 'llm', secret: true },
  { name: 'TATUM_API_KEY', group: 'data', secret: true },
  { name: 'APIFY_TOKEN', group: 'data', secret: true },
  { name: 'MOSTLYRIGHT_API_KEY', group: 'data', secret: true },
  { name: 'THYME_API_URL', group: 'thyme', secret: true },
  { name: 'THYME_API_KEY', group: 'thyme', secret: true },
  { name: 'THYME_PROJECT_ID', group: 'thyme', secret: false },
  { name: 'THYME_FUNCTION_ID', group: 'thyme', secret: false },
  { name: 'THYME_PULL_TOKEN', group: 'thyme', secret: true },
  { name: 'THYME_WORKSPACE_ID', group: 'thyme', secret: false },
  { name: 'SEPOLIA_RPC_URL', group: 'chain', secret: true },
  { name: 'PAYMENT_EXECUTOR', group: 'chain', secret: false },
  { name: 'AUTO_PAY_THRESHOLD', group: 'app', secret: false },
  { name: 'VITE_WALLETCONNECT_PROJECT_ID', group: 'app', secret: true },
  { name: 'APP_URL', group: 'app', secret: false },
  { name: 'DATABASE_PATH', group: 'app', secret: false },
]

function mask(value: string, secret: boolean): string {
  if (!secret) return value
  if (value.length <= 6) return '••••'
  return `${value.slice(0, 2)}••••${value.slice(-2)} (${value.length})`
}

export const getSettings = createServerFn({ method: 'GET' }).handler(async (): Promise<SettingsView> => {
  const { ensureBooted, bootStatus } = await import('./boot')
  ensureBooted()
  const { settings } = await import('../store/repos')
  const { serverEnv } = await import('../env')
  const { resolveExecutionMode } = await import('../payments/runner')
  const { buildOnboardingView } = await import('./thymeOnboarding')
  const boot = bootStatus()
  return {
    safeAddress: settings.get('safeAddress'),
    executor: serverEnv.paymentExecutor(),
    provider: serverEnv.llmProvider(),
    autoPayThreshold: serverEnv.autoPayThreshold(),
    execution: await resolveExecutionMode(),
    thyme: buildOnboardingView(),
    env: ENV_NAMES.map((e) => {
      const value = process.env[e.name] ?? ''
      return { name: e.name, group: e.group, configured: value !== '', masked: value ? mask(value, e.secret) : '—' }
    }),
    boot: { startedAt: boot.startedAt, running: boot.running, lastTickAt: boot.lastTickAt, lastError: boot.lastError },
    databasePath: serverEnv.databasePath(),
  }
})

export interface UpdateSettingsInput {
  safeAddress?: string | null
}

/** The Safe address is the only free-form setting left; everything about Thyme comes from the onboarding. */
export const updateSettings = createServerFn({ method: 'POST' })
  .validator((input: UpdateSettingsInput) => input)
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const { isAddress, getAddress } = await import('viem')
    const { settings, appendAudit } = await import('../store/repos')
    if (data.safeAddress !== undefined) {
      const t = data.safeAddress?.trim() ?? ''
      if (t !== '' && !isAddress(t)) throw new Error('Safe address is not a valid address')
      const safe = t === '' ? null : getAddress(t)
      const active = settings.get('thymeProfileStatus') === 'active'
      const current = settings.get('safeAddress')
      if (active && current && safe?.toLowerCase() !== current.toLowerCase()) {
        throw new Error('Payroll is enabled on the current Safe through Thyme. Forget the onboarding before changing the Safe.')
      }
      settings.set('safeAddress', safe)
      appendAudit({ actor: 'owner', event: 'settings.updated', details: { safeAddress: safe } })
    }
    return { ok: true }
  })

export interface ResetDemoResult {
  ok: true
  removed: { invoices: number; payouts: number; beneficiaries: number; audit: number; files: number }
}

/** Settings from the retired agent-key design; removed on reset so nothing stale lingers. */
const LEGACY_KEYS = ['rolesProxy', 'roleKey', 'mandateId', 'installTxHash', 'agentAddress', 'mandateSimulated', 'revokeTxHash', 'resumeTxHash']

/**
 * Clean slate before a rehearsal: removes invoices, payouts, beneficiaries, the audit log (SQLite + JSONL) and uploaded
 * PDFs; sets both agents back to running. Keeps the Safe address and the Thyme onboarding (profile, executable,
 * webhook): redoing those costs an owner transaction. Waits for an in-flight worker tick first.
 */
export const resetDemoData = createServerFn({ method: 'POST' }).handler(async (): Promise<ResetDemoResult> => {
  const { ensureBooted, bootStatus } = await import('./boot')
  ensureBooted()
  for (let i = 0; i < 100 && bootStatus().ticking; i++) await new Promise((resolve) => setTimeout(resolve, 100))
  const { getDb, settings, agents, appendAudit } = await import('../store/repos')
  const { invoicesDir } = await import('../store/sqlite')
  const { resetJsonl } = await import('../reports/audit')
  const { existsSync, readdirSync, rmSync } = await import('node:fs')
  const { join } = await import('node:path')
  const db = getDb()
  const count = (table: string): number => (db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
  const removed = { invoices: count('invoices'), payouts: count('payouts'), beneficiaries: count('beneficiaries'), audit: count('audit_log'), files: 0 }
  db.transaction(() => {
    db.run('DELETE FROM payouts')
    db.run('DELETE FROM invoices')
    db.run('DELETE FROM beneficiaries')
    db.run('DELETE FROM audit_log')
    db.run('UPDATE agents SET last_run_at = NULL')
    for (const key of LEGACY_KEYS) settings.remove(key)
    settings.remove('thymeLastExecutionId')
  })()
  for (const agent of agents.list()) agents.setStatus(agent.id, 'running')
  const dir = invoicesDir()
  if (existsSync(dir)) {
    for (const file of readdirSync(dir)) {
      if (!file.toLowerCase().endsWith('.pdf')) continue
      rmSync(join(dir, file), { force: true })
      removed.files += 1
    }
  }
  resetJsonl()
  appendAudit({ actor: 'owner', event: 'demo.reset', details: removed })
  return { ok: true, removed }
})
