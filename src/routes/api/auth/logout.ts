import { createFileRoute } from '@tanstack/react-router'

/** POST /api/auth/logout — clears the session cookie. */
export const Route = createFileRoute('/api/auth/logout')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { clearCookieHeader, SESSION_COOKIE } = await import('@/lib/server/session')
        return Response.json({ ok: true }, { headers: { 'set-cookie': clearCookieHeader(SESSION_COOKIE, request), 'cache-control': 'no-store' } })
      },
    },
  },
})
