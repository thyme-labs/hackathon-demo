import { createFileRoute } from '@tanstack/react-router'
import { join } from 'node:path'

const MAX_BYTES = 10 * 1024 * 1024
/** Amazon Bedrock Converse accepts images up to 3.75 MB each; resizing is out of scope, so larger images are refused. */
const MAX_IMAGE_BYTES = Math.floor(3.75 * 1024 * 1024)
/** Plain text goes straight into the prompt; keep it far below the model's context window. */
const MAX_TEXT_BYTES = 1024 * 1024
const ACCEPTED = '.pdf, .png, .jpg or .txt'

const megabytes = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(2)} MB`

/**
 * POST multipart/form-data with a `file` (PDF, PNG, JPEG or TXT; 10 MB). Stores <invoices dir>/<id>.<ext> and
 * queues the invoice. The format is derived from that extension downstream (pipeline, pdf_forensics).
 */
export const Route = createFileRoute('/api/invoices/upload')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { withRequestSession } = await import('@/lib/server/session')
        return withRequestSession(request, async (tenant) => {
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
          const { INVOICE_FORMAT_EXTENSION, invoiceFormatFromMime, invoiceFormatFromName } = await import('@/lib/agent/extract')
          const format = invoiceFormatFromMime(file.type) ?? invoiceFormatFromName(file.name)
          if (!format) {
            return Response.json({ error: `unsupported file type${file.type ? ` (${file.type})` : ''}: upload ${ACCEPTED}` }, { status: 415 })
          }
          if (file.size === 0 || file.size > MAX_BYTES) {
            return Response.json({ error: 'file empty or larger than 10 MB' }, { status: 413 })
          }
          if ((format === 'png' || format === 'jpeg') && file.size > MAX_IMAGE_BYTES) {
            return Response.json(
              { error: `image is ${megabytes(file.size)}; Amazon Bedrock accepts images up to 3.75 MB per file. Export a smaller PNG/JPEG or upload the PDF.` },
              { status: 415 },
            )
          }
          if (format === 'txt' && file.size > MAX_TEXT_BYTES) {
            return Response.json({ error: `text file is ${megabytes(file.size)}; plain-text invoices are limited to 1 MB` }, { status: 413 })
          }

          const [{ forTenant, newId }, { invoicesDir }, { onInvoiceQueued }] = await Promise.all([
            import('@/lib/store/repos'),
            import('@/lib/store/sqlite'),
            import('@/lib/integration'),
          ])
          const { invoices, appendAudit } = forTenant(tenant)

          const id = newId()
          const filePath = join(invoicesDir(), `${id}.${INVOICE_FORMAT_EXTENSION[format]}`)
          await Bun.write(filePath, await file.arrayBuffer())

          const payeeName = typeof form.get('payee_name') === 'string' ? String(form.get('payee_name')) : null
          const created = invoices.create({ id, file_path: filePath, status: 'queued', payee_name: payeeName })
          appendAudit({
            actor: 'owner',
            event: 'invoice.uploaded',
            invoiceId: created.id,
            details: { name: file.name, size: file.size, format },
          })
          void onInvoiceQueued(created.id).catch((err: unknown) => {
            appendAudit({ actor: 'agent', event: 'pipeline.error', invoiceId: created.id, details: { message: String(err) } })
          })
          return Response.json({ id: created.id, status: created.status }, { status: 201 })
        })
      },
    },
  },
})
