import { createFileRoute } from '@tanstack/react-router'

/** GET /api/reports/remittance/:payoutId — print-ready remittance advice (A4 HTML). */
export const Route = createFileRoute('/api/reports/remittance/$payoutId')({
  server: {
    handlers: {
      GET: async ({ params, request }) => {
        const { withRequestSession } = await import('@/lib/server/session')
        return withRequestSession(request, async () => {
          const { buildRemittance } = await import('@/lib/server/reports')
          try {
            const html = buildRemittance(params.payoutId)
            return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } })
          } catch (error) {
            return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 404 })
          }
        })
      },
    },
  },
})
