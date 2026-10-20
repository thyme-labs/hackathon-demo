import { Link, useLoaderData, useNavigate } from '@tanstack/react-router'
import {
  ArrowRightLeft,
  Bot,
  FileText,
  LayoutGrid,
  type LucideIcon,
  PieChart,
  Settings,
  ShieldCheck,
  Sparkles,
  Users,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { StatusDot } from '@/components/ui-kit/StatusDot'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { SessionChip } from '@/components/wallet/SessionChip'
import { WalletChip } from '@/components/wallet/WalletChip'
import { tourStore, useTour } from '@/lib/demo/tourStore'
import { Logo } from './Logo'

interface RailItem {
  to: string
  label: string
  icon: LucideIcon
}

const NAV: RailItem[] = [
  { to: '/dashboard', label: 'Dashboard', icon: LayoutGrid },
  { to: '/onboarding', label: 'Enable payroll (Safe + Thyme)', icon: ShieldCheck },
  { to: '/invoices', label: 'Invoices', icon: FileText },
  { to: '/beneficiaries', label: 'Beneficiaries', icon: Users },
  { to: '/agents', label: 'Agents', icon: Bot },
  { to: '/payouts', label: 'Payouts', icon: ArrowRightLeft },
  { to: '/reports', label: 'Reports', icon: PieChart },
]

function RailLink({ item }: { item: RailItem }) {
  const Icon = item.icon
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link
          to={item.to}
          aria-label={item.label}
          className="grid size-10 place-items-center rounded-lg text-dim transition-colors hover:bg-raised hover:text-text data-[status=active]:bg-raised data-[status=active]:text-text"
        >
          <Icon aria-hidden className="size-5" strokeWidth={1.5} />
        </Link>
      </TooltipTrigger>
      <TooltipContent side="right">{item.label}</TooltipContent>
    </Tooltip>
  )
}

/** Demo tenants only: restart the guided walkthrough from the dashboard. */
function GuideButton() {
  const navigate = useNavigate()
  const { active } = useTour()
  function handleGuide() {
    tourStore.start(0)
    void navigate({ to: '/dashboard', search: {} })
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-lg" onClick={handleGuide} aria-label="Guide" aria-pressed={active} className={cn('text-dim hover:bg-raised hover:text-text', active && 'bg-raised text-sage')}>
          <Sparkles aria-hidden className="size-5" strokeWidth={1.5} />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="right">Guide · restart the walkthrough</TooltipContent>
    </Tooltip>
  )
}

/** Fixed 76px icon rail: logo, primary nav, then settings + network dot + signed-in tenant + wallet at the bottom. */
export function Rail({ className }: { className?: string }) {
  const { demo } = useLoaderData({ from: '__root__' })
  return (
    <aside
      className={cn(
        'fixed inset-y-0 left-0 z-20 flex w-rail flex-col items-center border-r border-hairline bg-bg pt-7 pb-6',
        className,
      )}
    >
      <Link to="/dashboard" aria-label="Thyme Payroll" className="grid place-items-center">
        <Logo />
      </Link>
      <nav className="mt-14 grid gap-3">
        {NAV.map((item) => (
          <RailLink key={item.to} item={item} />
        ))}
      </nav>
      <div className="mt-auto grid justify-items-center gap-5">
        {demo.mode ? <GuideButton /> : null}
        <RailLink item={{ to: '/settings', label: 'Settings', icon: Settings }} />
        <StatusDot tone="ok" label="Sepolia" />
        <SessionChip />
        <WalletChip />
      </div>
    </aside>
  )
}
