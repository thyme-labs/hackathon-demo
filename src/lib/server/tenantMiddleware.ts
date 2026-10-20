// Server-function middleware: every tenant-scoped server fn resolves the session cookie, redirects to the connect
// page when there is none, and runs its handler inside the tenant context (src/lib/store/tenant.ts). Importable
// from client components: the server callback is stripped from the browser bundle.
import { createMiddleware } from '@tanstack/react-start'

export const tenantMiddleware = createMiddleware({ type: 'function' }).server(async ({ next }) => {
  const { requireSession, withTenant } = await import('./session')
  const session = requireSession()
  return withTenant(session.tenant, () => next({ context: { tenant: session.tenant, session } }))
})
