import { createFileRoute } from '@tanstack/react-router'
import { PayoutsPage } from '@/components/pages/PayoutsPage'
import { listPayouts } from '@/lib/server/payouts.fns'

export const Route = createFileRoute('/payouts')({
  loader: () => listPayouts(),
  component: () => <PayoutsPage initial={Route.useLoaderData()} />,
})
