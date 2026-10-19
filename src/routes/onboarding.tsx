import { createFileRoute } from '@tanstack/react-router'
import { OnboardingPage } from '@/components/pages/OnboardingPage'
import { getThymeOnboarding } from '@/lib/server/thyme.fns'

export const Route = createFileRoute('/onboarding')({
  loader: () => getThymeOnboarding(),
  component: () => <OnboardingPage initial={Route.useLoaderData()} />,
})
