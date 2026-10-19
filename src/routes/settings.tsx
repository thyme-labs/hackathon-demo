import { createFileRoute } from '@tanstack/react-router'
import { SettingsPage } from '@/components/pages/SettingsPage'
import { getSettings } from '@/lib/server/settings.fns'

export const Route = createFileRoute('/settings')({
  loader: () => getSettings(),
  component: () => <SettingsPage initial={Route.useLoaderData()} />,
})
