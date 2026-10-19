import { cn } from '@/lib/utils'
import { StatusDot, toneForStatus } from './StatusDot'

const LABELS: Record<string, string> = {
  queued: 'queued',
  investigating: 'investigating',
  needs_approval: 'needs approval',
  approved: 'approved',
  rejected: 'stopped',
  paying: 'paying',
  paid: 'paid',
  failed: 'failed',
  pending: 'pending',
  submitted: 'submitted',
  confirmed: 'confirmed',
  reverted: 'reverted',
  running: 'running',
  paused: 'paused',
  active: 'active',
  new: 'new',
  blocked: 'blocked',
}

/** Dot + lower-case label for invoice, payout, agent and beneficiary statuses. */
export function StatusPill({ status, className }: { status: string; className?: string }) {
  const tone = toneForStatus(status)
  const live = status === 'investigating' || status === 'paying' || status === 'submitted' || status === 'queued'
  return (
    <span className={cn('inline-flex items-center gap-1.5 whitespace-nowrap text-xs', tone === 'fail' && 'text-blocked', tone === 'warn' && 'text-paused', tone === 'idle' && 'text-dim', className)}>
      <StatusDot tone={tone} pulse={live} />
      {LABELS[status] ?? status}
    </span>
  )
}
