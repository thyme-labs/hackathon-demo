import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/api/invoices/$id')({
  server: {
    handlers: {
      GET: async ({ params, request }) => {
        const { withRequestSession } = await import('@/lib/server/session')
        return withRequestSession(request, async (tenant) => {
          const { forTenant } = await import('@/lib/store/repos')
          const { invoices, payouts, audit, beneficiaries } = forTenant(tenant)
          const invoice = invoices.get(params.id)
          if (!invoice) return Response.json({ error: 'not found' }, { status: 404 })
          return Response.json(
            {
              invoice: { ...invoice, checklist: safeJson(invoice.checklist_json), extracted: safeJson(invoice.extracted_json) },
              beneficiary: invoice.beneficiary_id ? beneficiaries.get(invoice.beneficiary_id) : null,
              payouts: payouts.byInvoice(invoice.id),
              audit: audit.list({ invoiceId: invoice.id, limit: 100 }),
            },
            { headers: { 'cache-control': 'no-store' } },
          )
        })
      },
    },
  },
})

function safeJson(text: string | null): unknown {
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
