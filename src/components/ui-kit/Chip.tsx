import { Lock, Sparkles } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export type ChipVariant = 'chain' | 'agent' | 'plain'

interface ChipProps {
  variant?: ChipVariant
  tone?: 'default' | 'pass' | 'warn' | 'fail'
  children: ReactNode
  className?: string
  title?: string
}

const toneClass: Record<NonNullable<ChipProps['tone']>, string> = {
  default: 'text-secondary-foreground',
  pass: 'text-sage',
  warn: 'text-paused',
  fail: 'text-blocked',
}

/** Rule chip. Lock = enforced on chain, sparkle = checked by the agent. */
export function Chip({ variant = 'plain', tone = 'default', children, className, title }: ChipProps) {
  const Icon = variant === 'chain' ? Lock : variant === 'agent' ? Sparkles : null
  const iconTitle = variant === 'chain' ? 'Enforced on chain' : variant === 'agent' ? 'Checked by the agent' : undefined
  return (
    <span
      title={title ?? iconTitle}
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-md bg-raised px-2 py-1.5 text-xs leading-none',
        toneClass[tone],
        className,
      )}
    >
      {Icon ? <Icon aria-hidden className="size-3 text-dim" /> : null}
      {children}
    </span>
  )
}

/** Legend for the two chip kinds. */
export function ChipLegend({ className }: { className?: string }) {
  return (
    <div className={cn('flex items-center gap-3 text-dim', className)} aria-label="Rule types">
      <span className="inline-flex items-center gap-1 text-xs" title="Enforced on chain">
        <Lock aria-hidden className="size-3" />
        chain
      </span>
      <span className="inline-flex items-center gap-1 text-xs" title="Checked by the agent">
        <Sparkles aria-hidden className="size-3" />
        agent
      </span>
    </div>
  )
}
