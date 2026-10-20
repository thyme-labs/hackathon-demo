import { createFileRoute } from '@tanstack/react-router'

/** GET /api/reports/ledger?month=YYYY-MM — monthly ledger CSV download. */
export const Route = createFileRoute('/api/reports/ledger')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { withRequestSession } = await import('@/lib/server/session')
        return withRequestSession(request, async () => {
          const { buildLedgerCsv } = await import('@/lib/server/reports')
          const month = new URL(request.url).searchParams.get('month')
          const csv = buildLedgerCsv(month && /^\d{4}-\d{2}$/.test(month) ? month : null)
          return new Response(csv, {
            headers: {
              'content-type': 'text/csv; charset=utf-8',
              'content-disposition': `attachment; filename="ledger-${month ?? 'current'}.csv"`,
              'cache-control': 'no-store',
            },
          })
        })
      },
    },
  },
})
