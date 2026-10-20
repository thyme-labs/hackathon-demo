import { createFileRoute } from '@tanstack/react-router'

const DEMO_FILE_NAME = /^[A-Za-z0-9._-]+\.pdf$/

/** GET /api/demo/invoices/:file — downloads a synthetic demo/invoices/<file>.pdf that is listed in demo/payees.json. */
export const Route = createFileRoute('/api/demo/invoices/$file')({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const file = params.file
        if (!DEMO_FILE_NAME.test(file)) return Response.json({ error: 'invalid demo file name' }, { status: 400 })
        const [{ basename, join }, { demoInvoicesDir }, { default: demoPayees }] = await Promise.all([
          import('node:path'),
          import('@/lib/server/demo'),
          import('../../../../../demo/payees.json'),
        ])
        const listed = (demoPayees as unknown as { invoices: { file: string }[] }).invoices.some((invoice) => basename(invoice.file) === file)
        if (!listed) return Response.json({ error: 'not found' }, { status: 404 })
        const pdf = Bun.file(join(demoInvoicesDir(), file))
        if (!(await pdf.exists())) return Response.json({ error: 'not found' }, { status: 404 })
        return new Response(pdf, {
          headers: {
            'content-type': 'application/pdf',
            'content-disposition': `attachment; filename="${file}"`,
            'cache-control': 'no-store',
          },
        })
      },
    },
  },
})
