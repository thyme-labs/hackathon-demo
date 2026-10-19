import { createFileRoute } from '@tanstack/react-router'
import pkg from '../../../package.json'

export const Route = createFileRoute('/api/health')({
  server: {
    handlers: {
      GET: async () => {
        const { pingDb } = await import('@/lib/store/sqlite')
        const db = pingDb()
        if (db) {
          const { ensureBooted } = await import('@/lib/server/boot')
          ensureBooted()
        }
        return Response.json(
          {
            ok: db,
            version: process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) ?? pkg.version,
            time: new Date().toISOString(),
            db: db ? 'ok' : 'error',
          },
          { status: db ? 200 : 503, headers: { 'cache-control': 'no-store' } },
        )
      },
    },
  },
})
