import { createFileRoute } from '@tanstack/react-router'

/** POST /api/auth/nonce — SIWE step 1: a random nonce, also kept in a short-lived signed httpOnly cookie. */
export const Route = createFileRoute('/api/auth/nonce')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { issueNonce } = await import('@/lib/server/session')
        const { nonce, cookie } = issueNonce(request)
        return Response.json({ nonce, chainId: 11155111 }, { headers: { 'set-cookie': cookie, 'cache-control': 'no-store' } })
      },
    },
  },
})
