import { createFileRoute } from '@tanstack/react-router'
import { ReportsPage } from '@/components/pages/ReportsPage'
import { getReports } from '@/lib/server/reports.fns'

export const Route = createFileRoute('/reports')({
  validateSearch: (search: Record<string, unknown>): { month?: string } => (typeof search.month === 'string' && /^\d{4}-\d{2}$/.test(search.month) ? { month: search.month } : {}),
  loaderDeps: ({ search }) => ({ month: search.month ?? null }),
  loader: ({ deps }) => getReports({ data: { month: deps.month } }),
  component: ReportsRoute,
})

function ReportsRoute() {
  const data = Route.useLoaderData()
  return <ReportsPage data={data} />
}
