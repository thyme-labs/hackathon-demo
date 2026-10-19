import { createFileRoute } from '@tanstack/react-router'
import { AgentsPage } from '@/components/pages/AgentsPage'
import { listAgents } from '@/lib/server/agents.fns'

export const Route = createFileRoute('/agents')({
  loader: () => listAgents(),
  component: () => <AgentsPage initial={Route.useLoaderData()} />,
})
