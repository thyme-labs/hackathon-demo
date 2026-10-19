import { Check, LoaderCircle, Minus, TriangleAlert, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Chip } from './Chip'

export interface CheckItemData {
  id: string
  label: string
  status: 'pass' | 'warn' | 'fail' | 'skip' | 'pending' | 'running'
  enforcement: 'chain' | 'agent'
  evidence: string
  source: string
  at: string | null
}

const ICONS = {
  pass: { Icon: Check, cls: 'text-sage' },
  warn: { Icon: TriangleAlert, cls: 'text-paused' },
  fail: { Icon: X, cls: 'text-blocked' },
  skip: { Icon: Minus, cls: 'text-dim' },
  pending: { Icon: Minus, cls: 'text-dim/40' },
  running: { Icon: LoaderCircle, cls: 'text-sage animate-spin' },
} as const

const TONE = { pass: 'pass', warn: 'warn', fail: 'fail', skip: 'default', pending: 'default', running: 'default' } as const

/** One checklist line: status icon, label, chain/agent chip, evidence and source. */
export function CheckItem({ item, compact = false }: { item: CheckItemData; compact?: boolean }) {
  const { Icon, cls } = ICONS[item.status]
  const done = item.status !== 'pending' && item.status !== 'running'
  return (
    <div className={cn('grid grid-cols-[1.25rem_1fr] gap-x-3 py-3 border-b border-hairline last:border-0', done && 'animate-rise', item.status === 'pending' && 'opacity-40')}>
      <Icon aria-hidden className={cn('mt-0.5 size-4', cls)} strokeWidth={2} />
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className={cn('text-sm', item.status === 'fail' && 'text-blocked', item.status === 'warn' && 'text-paused')}>{item.label}</span>
          <Chip variant={item.enforcement} tone={TONE[item.status]} className="py-1">
            {item.enforcement === 'chain' ? 'chain' : 'agent'}
          </Chip>
          {item.status === 'skip' ? <span className="text-xs text-dim">skipped</span> : null}
        </div>
        {done && !compact ? (
          <>
            <p className="mt-1 text-xs leading-relaxed text-secondary-foreground">{item.evidence}</p>
            {item.source ? <p className="mt-1 truncate text-xs text-dim" title={item.source}>{item.source}</p> : null}
          </>
        ) : null}
        {item.status === 'running' ? <p className="mt-1 text-xs text-dim">checking…</p> : null}
      </div>
    </div>
  )
}
