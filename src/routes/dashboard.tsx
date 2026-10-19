import { createFileRoute } from '@tanstack/react-router'
import { DashboardPage } from '@/components/pages/DashboardPage'
import { getDashboard } from '@/lib/server/dashboard.fns'

export const Route = createFileRoute('/dashboard')({
  loader: () => getDashboard(),
  component: () => <DashboardPage initial={Route.useLoaderData()} />,
})
