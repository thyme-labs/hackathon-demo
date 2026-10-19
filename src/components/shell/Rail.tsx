import { Link } from '@tanstack/react-router'
import {
  ArrowRightLeft,
  Bot,
  FileText,
  LayoutGrid,
  type LucideIcon,
  PieChart,
  Settings,
  Users,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { StatusDot } from '@/components/ui-kit/StatusDot'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { WalletChip } from '@/components/wallet/WalletChip'
import { Logo } from './Logo'

interface RailItem {
  to: string
  label: string
  icon: LucideIcon
}

const NAV: RailItem[] = [
  { to: '/dashboard', label: 'Dashboard', icon: LayoutGrid },
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

/** Fixed 76px icon rail: logo, primary nav, then settings + wallet + network dot at the bottom. */
export function Rail({ className }: { className?: string }) {
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
        <RailLink item={{ to: '/settings', label: 'Settings', icon: Settings }} />
        <StatusDot tone="ok" label="Sepolia" />
        <WalletChip />
      </div>
    </aside>
  )
}
