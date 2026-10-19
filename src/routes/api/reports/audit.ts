import { createFileRoute } from '@tanstack/react-router'

/** GET /api/reports/audit — hash-chained audit log as JSON Lines. */
export const Route = createFileRoute('/api/reports/audit')({
  server: {
    handlers: {
      GET: async () => {
        const { buildAuditJsonl } = await import('@/lib/server/reports')
        return new Response(buildAuditJsonl(), {
          headers: {
            'content-type': 'application/x-ndjson; charset=utf-8',
            'content-disposition': 'attachment; filename="audit.jsonl"',
            'cache-control': 'no-store',
          },
        })
      },
    },
  },
})
