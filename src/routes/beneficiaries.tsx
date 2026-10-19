import { createFileRoute } from '@tanstack/react-router'
import { BeneficiariesPage } from '@/components/pages/BeneficiariesPage'
import { listBeneficiaries } from '@/lib/server/beneficiaries.fns'

export const Route = createFileRoute('/beneficiaries')({
  loader: () => listBeneficiaries(),
  component: () => <BeneficiariesPage initial={Route.useLoaderData()} />,
})
