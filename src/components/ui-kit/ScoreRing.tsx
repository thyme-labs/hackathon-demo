import { cn } from '@/lib/utils'

interface ScoreRingProps {
  value: number | null
  threshold?: number
  failed?: boolean
  size?: 'sm' | 'lg'
  className?: string
}

const R = 46
const C = 2 * Math.PI * R

/** Score 0..100 as a thin ring. Sage at/above the auto-pay threshold, amber below, red when a check failed. */
export function ScoreRing({ value, threshold = 100, failed = false, size = 'lg', className }: ScoreRingProps) {
  const pct = value === null ? 0 : Math.max(0, Math.min(100, value))
  const offset = C - (C * pct) / 100
  const tone = failed ? 'stroke-blocked' : value !== null && value >= threshold ? 'stroke-sage' : 'stroke-paused'
  return (
    <div className={cn('relative grid place-items-center', size === 'lg' ? 'size-24' : 'size-12', className)}>
      <svg viewBox="0 0 100 100" className="size-full -rotate-90" aria-hidden>
        <circle cx="50" cy="50" r={R} fill="none" strokeWidth="4" className="stroke-track" />
        <circle
          cx="50"
          cy="50"
          r={R}
          fill="none"
          strokeWidth="4"
          strokeLinecap="round"
          strokeDasharray={C}
          strokeDashoffset={offset}
          className={cn('transition-[stroke-dashoffset] duration-700', tone)}
        />
      </svg>
      <div className={cn('absolute inset-0 grid place-items-center font-mono tracking-tightest', size === 'lg' ? 'text-2xl' : 'text-xs')}>
        {value === null ? '—' : Math.round(value)}
      </div>
    </div>
  )
}
