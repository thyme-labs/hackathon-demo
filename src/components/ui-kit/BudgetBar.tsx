import { cn } from '@/lib/utils'
import { formatEur } from './format'

interface BudgetBarProps {
  used: number
  limit: number
  period?: string
  className?: string
}

/** Thin progress bar with "used / limit" in mono. Turns amber past 80 %, red past 100 %. */
export function BudgetBar({ used, limit, period = 'Month', className }: BudgetBarProps) {
  const ratio = limit > 0 ? Math.min(used / limit, 1) : 0
  const pct = Math.round(ratio * 100)
  const tone = used > limit ? 'bg-blocked' : ratio > 0.8 ? 'bg-paused' : 'bg-sage'
  return (
    <div className={cn('text-xs', className)}>
      <div className="flex items-center justify-between">
        <span className="font-mono">
          {formatEur(used)} <span className="text-dim">/ {formatEur(limit)}</span>
        </span>
        <span className="text-dim">{period}</span>
      </div>
      <div
        className="mt-2.5 h-0.75 w-full overflow-hidden rounded-full bg-track"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
      >
        <div className={cn('h-full rounded-full transition-[width]', tone, widthClass(pct))} />
      </div>
    </div>
  )
}

// Predefined Tailwind fractions only (no arbitrary values).
const WIDTH_STEPS: ReadonlyArray<[number, string]> = [
  [0, 'w-0'],
  [8, 'w-1/12'],
  [17, 'w-1/6'],
  [20, 'w-1/5'],
  [25, 'w-1/4'],
  [33, 'w-1/3'],
  [40, 'w-2/5'],
  [50, 'w-1/2'],
  [60, 'w-3/5'],
  [67, 'w-2/3'],
  [75, 'w-3/4'],
  [80, 'w-4/5'],
  [83, 'w-5/6'],
  [92, 'w-11/12'],
  [100, 'w-full'],
]

function widthClass(pct: number): string {
  let best = WIDTH_STEPS[0]
  for (const step of WIDTH_STEPS) {
    if (Math.abs(step[0] - pct) < Math.abs(best[0] - pct)) best = step
  }
  return best[1]
}
