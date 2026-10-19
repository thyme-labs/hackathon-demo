import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

interface StatProps {
  label: string
  value: ReactNode
  hint?: ReactNode
  mono?: boolean
  className?: string
}

/** Compact metric tile: small muted label, large number. */
export function Stat({ label, value, hint, mono = true, className }: StatProps) {
  return (
    <div className={cn('rounded-xl bg-surface px-5 py-4', className)}>
      <div className="text-xs text-dim">{label}</div>
      <div className={cn('mt-2 text-2xl font-normal tracking-tightest', mono && 'font-mono')}>{value}</div>
      {hint ? <div className="mt-1 text-xs text-dim">{hint}</div> : null}
    </div>
  )
}
