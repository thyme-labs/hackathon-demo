import { createFileRoute } from '@tanstack/react-router'
import { DashboardPage } from '@/components/pages/DashboardPage'
import { getDashboard } from '@/lib/server/dashboard.fns'

export const Route = createFileRoute('/dashboard')({
  /** ?tour=1 starts the jury walkthrough (demo tenants only; the Tour drops the flag once started). */
  validateSearch: (search: Record<string, unknown>): { tour?: number } => (search.tour === 1 || search.tour === '1' ? { tour: 1 } : {}),
  loader: () => getDashboard(),
  component: () => <DashboardPage initial={Route.useLoaderData()} />,
})
