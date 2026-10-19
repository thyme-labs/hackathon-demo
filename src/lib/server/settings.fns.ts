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
  { name: 'THYME_PAY_WEBHOOK_URL', group: 'thyme', secret: true },
  { name: 'THYME_EXECUTABLE_ID', group: 'thyme', secret: false },
  { name: 'THYME_PULL_TOKEN', group: 'thyme', secret: true },
  { name: 'SEPOLIA_RPC_URL', group: 'chain', secret: true },
  { name: 'AGENT_PRIVATE_KEY', group: 'chain', secret: true },
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
  const { getThymeTriggerMode } = await import('../thyme/env')
  const { getAgentAddress } = await import('../chain/agentSigner')
  const { resolveAgentAddress } = await import('./mandate')
  const all = settings.all()
  const boot = bootStatus()
  const fromKey = getAgentAddress()
  return {
    safeAddress: all.safeAddress ?? null,
    rolesProxy: all.rolesProxy ?? null,
    roleKey: all.roleKey ?? null,
    mandateId: all.mandateId ?? null,
    installTxHash: all.installTxHash ?? null,
    agentAddress: await resolveAgentAddress(),
    agentFromKey: Boolean(fromKey),
    executor: serverEnv.paymentExecutor(),
    provider: serverEnv.llmProvider(),
    autoPayThreshold: serverEnv.autoPayThreshold(),
    execution: await resolveExecutionMode(serverEnv.paymentExecutor()),
    thymeTriggerMode: getThymeTriggerMode(),
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
  rolesProxy?: string | null
  roleKey?: string | null
  agentAddress?: string | null
}

export const updateSettings = createServerFn({ method: 'POST' })
  .validator((input: UpdateSettingsInput) => input)
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const { isAddress, getAddress, isHex } = await import('viem')
    const { settings, appendAudit } = await import('../store/repos')
    const addr = (v: string | null | undefined, label: string): string | null | undefined => {
      if (v === undefined) return undefined
      const t = v?.trim() ?? ''
      if (t === '') return null
      if (!isAddress(t)) throw new Error(`${label} is not a valid address`)
      return getAddress(t)
    }
    const safe = addr(data.safeAddress, 'Safe address')
    const roles = addr(data.rolesProxy, 'Roles proxy')
    const agent = addr(data.agentAddress, 'Agent address')
    if (safe !== undefined) settings.set('safeAddress', safe)
    if (roles !== undefined) settings.set('rolesProxy', roles)
    if (agent !== undefined) settings.set('agentAddress', agent)
    if (data.roleKey !== undefined) {
      const key = data.roleKey?.trim() ?? ''
      if (key && !(isHex(key) && key.length === 66)) throw new Error('Role key must be a 32-byte hex value')
      settings.set('roleKey', key || null)
    }
    appendAudit({ actor: 'owner', event: 'settings.updated', details: { safeAddress: safe, rolesProxy: roles, agentAddress: agent, roleKey: data.roleKey === undefined ? undefined : Boolean(data.roleKey) } })
    return { ok: true }
  })

export interface ResetDemoResult {
  ok: true
  removed: { invoices: number; payouts: number; beneficiaries: number; audit: number; files: number }
}

const MANDATE_KEYS = ['rolesProxy', 'roleKey', 'mandateId', 'installTxHash']

/**
 * Clean slate before a rehearsal: removes invoices, payouts, beneficiaries, the audit log (SQLite + JSONL) and uploaded
 * PDFs; forgets the mandate (roles proxy / role key) so the next registration installs again; keeps the Safe and agent
 * addresses and sets both agents back to running. Waits for an in-flight worker tick first.
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
    for (const key of MANDATE_KEYS) settings.remove(key)
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
