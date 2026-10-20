import { createFileRoute } from '@tanstack/react-router'

/** GET /api/auth/me — the current session (tenant, kind, address, label) or { session: null }. */
export const Route = createFileRoute('/api/auth/me')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { readSession, toView } = await import('@/lib/server/session')
        const session = readSession(request)
        return Response.json({ session: session ? toView(session) : null }, { headers: { 'cache-control': 'no-store' } })
      },
    },
  },
})
