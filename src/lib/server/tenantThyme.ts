// Server-only: Thyme pieces that are per tenant. Each tenant gets its own pull token (the shared secret the
// Flow task presents as X-Thyme-Token); /api/thyme/pending and /api/webhooks/thyme map the token back to the
// tenant. The env THYME_PULL_TOKEN stays the founder tenant's token for the executable created before tenants.
import { randomBytes } from 'node:crypto'
import { serverEnv } from '../env'
import { founderTenant, forTenant, settings, tenantByPullToken } from '../store/repos'
import { currentTenant } from '../store/tenant'
import { THYME_SETTINGS_KEYS } from '../thyme/types'

if (typeof window !== 'undefined') {
  throw new Error('src/lib/server/tenantThyme.ts is server-only')
}

/** The current tenant's pull token; generated on first use (the founder inherits env THYME_PULL_TOKEN). */
export function tenantPullToken(): string {
  const existing = settings.get(THYME_SETTINGS_KEYS.pullToken)
  if (existing) return existing
  const envToken = serverEnv.thymePullToken()
  const token = currentTenant() === founderTenant() && envToken ? envToken : randomBytes(32).toString('hex')
  settings.set(THYME_SETTINGS_KEYS.pullToken, token)
  return token
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/**
 * Tenant for an inbound Thyme request by its X-Thyme-Token: a tenant's stored token, or the env token (founder).
 * With neither an env token nor a presented token the routes run open for the founder tenant (local dev only).
 */
export function resolveThymeTenant(presented: string): string | null {
  const envToken = serverEnv.thymePullToken()
  if (presented) {
    const byToken = tenantByPullToken(presented)
    if (byToken) return byToken
    if (envToken && timingSafeEqual(envToken, presented)) return founderTenant()
    return null
  }
  if (!envToken) {
    const founder = founderTenant()
    // Open mode only when the founder has not generated its own token either.
    return forTenant(founder).settings.get(THYME_SETTINGS_KEYS.pullToken) ? null : founder
  }
  return null
}
