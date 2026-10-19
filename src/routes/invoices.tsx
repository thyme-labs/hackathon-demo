import { createFileRoute } from '@tanstack/react-router'
import { InvoicesPage } from '@/components/pages/InvoicesPage'
import { listInvoices } from '@/lib/server/invoices.fns'

export const Route = createFileRoute('/invoices')({
  validateSearch: (search: Record<string, unknown>): { id?: string } => (typeof search.id === 'string' && search.id ? { id: search.id } : {}),
  loader: () => listInvoices(),
  component: InvoicesRoute,
})

function InvoicesRoute() {
  const initial = Route.useLoaderData()
  const { id } = Route.useSearch()
  return <InvoicesPage initial={initial} selectedId={id} />
}
