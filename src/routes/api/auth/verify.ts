import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'

const Body = z.object({ message: z.string().min(1), signature: z.string().regex(/^0x[0-9a-fA-F]+$/) })

/** POST /api/auth/verify {message, signature} — SIWE step 2: verify, then set the session cookie. */
export const Route = createFileRoute('/api/auth/verify')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const parsed = Body.safeParse(await request.json().catch(() => null))
        if (!parsed.success) return Response.json({ error: 'expected { message, signature }' }, { status: 400 })
        const { parseSiweMessage, checkSiweFields, createWalletSession, sessionCookie, clearCookieHeader, NONCE_COOKIE, toView } = await import('@/lib/server/session')
        const fields = parseSiweMessage(parsed.data.message)
        if (!fields) return Response.json({ error: 'not a sign-in message' }, { status: 400 })
        try {
          checkSiweFields(fields, request)
        } catch (error) {
          return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 401 })
        }
        const { verifyMessage } = await import('viem')
        const ok = await verifyMessage({ address: fields.address as `0x${string}`, message: parsed.data.message, signature: parsed.data.signature as `0x${string}` }).catch(() => false)
        if (!ok) return Response.json({ error: 'signature does not match the address' }, { status: 401 })
        const session = createWalletSession(fields.address)
        const headers = new Headers({ 'cache-control': 'no-store' })
        headers.append('set-cookie', sessionCookie(session, request))
        headers.append('set-cookie', clearCookieHeader(NONCE_COOKIE, request))
        return Response.json({ session: toView(session) }, { headers })
      },
    },
  },
})
