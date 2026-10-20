// Server functions for the jury demo: start (anonymous demo tenant + seed + demoMode) and the tour's anchors.
// Neither uses tenantMiddleware: startJuryDemo creates the session, getDemoState must not redirect.
import { createServerFn } from '@tanstack/react-start'
import type { JuryDemoState } from './juryDemo'
import type { SessionView } from './session'

export type { JuryDemoState }

export interface StartJuryDemoResult {
  session: SessionView
  seeded: boolean
  state: JuryDemoState
}

/** demoMode and the seeded anchors of the current session's tenant; { mode: false } without a session. */
export const getDemoState = createServerFn({ method: 'GET' }).handler(async (): Promise<JuryDemoState> => {
  const { currentSession, withTenant } = await import('./session')
  const { readJuryDemoState, EMPTY_DEMO_STATE } = await import('./juryDemo')
  const session = currentSession()
  if (!session) return EMPTY_DEMO_STATE
  return withTenant(session.tenant, () => readJuryDemoState())
})

/**
 * "Jury demo": reuses the current anonymous session or opens a fresh one (cookie set on this response), seeds the
 * tenant once from demo/fixtures and switches demoMode on. Anonymous tenants always pay through the labelled
 * simulation; a wallet session is never turned into a demo.
 */
export const startJuryDemo = createServerFn({ method: 'POST' }).handler(async (): Promise<StartJuryDemoResult> => {
  const { getRequest, setResponseHeader } = await import('@tanstack/react-start/server')
  const { currentSession, createAnonymousSession, sessionCookie, toView, withTenant } = await import('./session')
  const { seedJuryDemo, readJuryDemoState } = await import('./juryDemo')
  const existing = currentSession()
  const session = existing?.kind === 'anon' ? existing : createAnonymousSession()
  if (session !== existing) setResponseHeader('set-cookie', sessionCookie(session, getRequest()))
  const result = await withTenant(session.tenant, async () => {
    const seeded = await seedJuryDemo()
    return { seeded: seeded.seeded, state: readJuryDemoState() }
  })
  return { session: toView(session), ...result }
})
