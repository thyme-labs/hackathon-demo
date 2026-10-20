import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'

const Body = z.object({ address: z.string().regex(/^0x[0-9a-fA-F]{40}$/) })

/** POST /api/auth/dev-login {address} — smoke tests only: a wallet session without a signature. Disabled in production. */
export const Route = createFileRoute('/api/auth/dev-login')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (process.env.NODE_ENV === 'production') return Response.json({ error: 'not found' }, { status: 404 })
        const parsed = Body.safeParse(await request.json().catch(() => null))
        if (!parsed.success) return Response.json({ error: 'expected { address }' }, { status: 400 })
        const { createWalletSession, sessionCookie, toView } = await import('@/lib/server/session')
        const session = createWalletSession(parsed.data.address)
        return Response.json({ session: toView(session) }, { headers: { 'set-cookie': sessionCookie(session, request), 'cache-control': 'no-store' } })
      },
    },
  },
})
