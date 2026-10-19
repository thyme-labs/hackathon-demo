import { cn } from '@/lib/utils'

export type DotTone = 'ok' | 'warn' | 'fail' | 'idle'

interface StatusDotProps {
  tone?: DotTone
  pulse?: boolean
  className?: string
  label?: string
}

const toneClass: Record<DotTone, string> = {
  ok: 'bg-sage',
  warn: 'bg-paused',
  fail: 'bg-blocked',
  idle: 'bg-dim',
}

/** 6px status dot. Green = running/confirmed, amber = paused/review, red = blocked/failed. */
export function StatusDot({ tone = 'ok', pulse = false, className, label }: StatusDotProps) {
  return (
    <span
      aria-label={label}
      title={label}
      className={cn('inline-block size-1.5 shrink-0 rounded-full', toneClass[tone], pulse && 'animate-pulse', className)}
    />
  )
}

export function toneForStatus(status: string): DotTone {
  switch (status) {
    case 'running':
    case 'active':
    case 'confirmed':
    case 'paid':
    case 'approved':
    case 'pass':
      return 'ok'
    case 'paused':
    case 'needs_approval':
    case 'investigating':
    case 'submitted':
    case 'paying':
    case 'warn':
      return 'warn'
    case 'blocked':
    case 'failed':
    case 'reverted':
    case 'rejected':
    case 'fail':
      return 'fail'
    default:
      return 'idle'
  }
}
