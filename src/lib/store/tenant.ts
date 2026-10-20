// Server-only tenant context. A tenant is the lower-case owner address of a wallet session or 'anon:<id>'
// for a demo session. Server functions and API routes resolve it from the session cookie and run their
// work inside runWithTenant(); the repos bound to the context (src/lib/store/repos.ts) refuse to run
// without one, so no query can ever read another tenant's rows by accident.
import { AsyncLocalStorage } from 'node:async_hooks'

if (typeof window !== 'undefined') {
  throw new Error('src/lib/store/tenant.ts is server-only')
}

/** Settings rows shared by the whole process (session secret, founder tenant). */
export const GLOBAL_TENANT = '_global'
/** The owner that onboarded the production Safe; migration 005 moved every pre-tenant row under it. */
export const FOUNDER_TENANT_FALLBACK = '0x38bd0c38786a20f2890675e8c4622813b8b3bf16'

const storage = new AsyncLocalStorage<string>()

export function runWithTenant<T>(tenantId: string, fn: () => T): T {
  return storage.run(tenantId, fn)
}

export function tryCurrentTenant(): string | null {
  return storage.getStore() ?? null
}

export function currentTenant(): string {
  const tenant = storage.getStore()
  if (!tenant) throw new Error('no tenant in context: resolve the session first (withSession / runWithTenant)')
  return tenant
}

export function isAnonymousTenant(tenantId: string): boolean {
  return tenantId.startsWith('anon:')
}

/** File-system safe form of a tenant id (per-tenant audit JSONL). */
export function tenantSlug(tenantId: string): string {
  return tenantId.replace(/[^a-z0-9]/gi, '_').toLowerCase()
}
