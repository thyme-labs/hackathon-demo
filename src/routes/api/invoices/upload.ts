import { createFileRoute } from '@tanstack/react-router'
import { join } from 'node:path'

const MAX_BYTES = 15 * 1024 * 1024

/** POST multipart/form-data with a `file` (PDF). Stores <invoices dir>/<id>.pdf and queues the invoice. */
export const Route = createFileRoute('/api/invoices/upload')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let form: FormData
        try {
          form = await request.formData()
        } catch {
          return Response.json({ error: 'expected multipart/form-data' }, { status: 400 })
        }
        const file = form.get('file')
        if (!(file instanceof File)) {
          return Response.json({ error: 'missing file field "file"' }, { status: 400 })
        }
        const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')
        if (!isPdf) return Response.json({ error: 'only PDF is accepted' }, { status: 415 })
        if (file.size === 0 || file.size > MAX_BYTES) {
          return Response.json({ error: 'file empty or larger than 15 MB' }, { status: 413 })
        }

        const [{ invoices, appendAudit, newId }, { invoicesDir }, { onInvoiceQueued }] = await Promise.all([
          import('@/lib/store/repos'),
          import('@/lib/store/sqlite'),
          import('@/lib/integration'),
        ])

        const id = newId()
        const filePath = join(invoicesDir(), `${id}.pdf`)
        await Bun.write(filePath, await file.arrayBuffer())

        const payeeName = typeof form.get('payee_name') === 'string' ? String(form.get('payee_name')) : null
        const created = invoices.create({ id, file_path: filePath, status: 'queued', payee_name: payeeName })
        appendAudit({
          actor: 'owner',
          event: 'invoice.uploaded',
          invoiceId: created.id,
          details: { name: file.name, size: file.size },
        })
        void onInvoiceQueued(created.id).catch((err: unknown) => {
          appendAudit({ actor: 'agent', event: 'pipeline.error', invoiceId: created.id, details: { message: String(err) } })
        })
        return Response.json({ id: created.id, status: created.status }, { status: 201 })
      },
    },
  },
})
