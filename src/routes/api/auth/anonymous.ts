import { createFileRoute } from '@tanstack/react-router'

/** POST /api/auth/anonymous — "Continue without a wallet": a fresh demo tenant (anon:<id>, executor simulated). */
export const Route = createFileRoute('/api/auth/anonymous')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { createAnonymousSession, sessionCookie, toView } = await import('@/lib/server/session')
        const session = createAnonymousSession()
        return Response.json({ session: toView(session) }, { headers: { 'set-cookie': sessionCookie(session, request), 'cache-control': 'no-store' } })
      },
    },
  },
})
