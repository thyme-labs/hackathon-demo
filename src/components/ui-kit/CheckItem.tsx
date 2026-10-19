import { Check, ChevronDown, LoaderCircle, Minus, TriangleAlert, X } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import type { CheckDescription } from '@/lib/agent/descriptions/checks'
import { cn } from '@/lib/utils'
import { CheckInfo } from './CheckInfo'
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

interface CheckItemProps {
  item: CheckItemData
  /** Hide evidence and source until the row is expanded. */
  compact?: boolean
  /** Start expanded (full evidence and source). The row remembers later toggles while it stays mounted. */
  defaultExpanded?: boolean
  /** Description for the info tooltip. Defaults to the lookup by `item.id`; pass null to hide the icon. */
  description?: CheckDescription | null
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

/** True when the element hides part of its text (line-clamp or truncate). */
const isClipped = (el: HTMLElement): boolean => el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1

/** One checklist line: status icon, label, info tooltip, chain/agent chip, evidence and source with expand/collapse. */
export function CheckItem({ item, compact = false, defaultExpanded = false, description }: CheckItemProps) {
  const { Icon, cls } = ICONS[item.status]
  const done = item.status !== 'pending' && item.status !== 'running'
  const hasDetails = done && (item.evidence !== '' || item.source !== '')
  const [expanded, setExpanded] = useState(defaultExpanded)
  const [clipped, setClipped] = useState(false)
  const evidenceRef = useRef<HTMLParagraphElement>(null)
  const sourceRef = useRef<HTMLParagraphElement>(null)
  const detailsId = useId()

  const showDetails = hasDetails && (!compact || expanded)
  const clamp = showDetails && !expanded

  // Measure whether the collapsed lines actually hide text, so the chevron only appears when there is more to see.
  useEffect(() => {
    if (!clamp || typeof ResizeObserver === 'undefined') return
    const els = [evidenceRef.current, sourceRef.current].filter((el): el is HTMLParagraphElement => el !== null)
    if (els.length === 0) {
      setClipped(false)
      return
    }
    const measure = () => setClipped(els.some(isClipped))
    measure()
    const observer = new ResizeObserver(measure)
    for (const el of els) observer.observe(el)
    return () => observer.disconnect()
  }, [clamp, item.evidence, item.source])

  const canToggle = hasDetails && (compact || expanded || clipped)

  const handleToggle = () => {
    setExpanded((value) => !value)
  }

  return (
    <div className={cn('grid grid-cols-[1.25rem_1fr] gap-x-3 py-3 border-b border-hairline last:border-0', done && 'animate-rise', item.status === 'pending' && 'opacity-40')}>
      <Icon aria-hidden className={cn('mt-0.5 size-4', cls)} strokeWidth={2} />
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className={cn('text-sm', item.status === 'fail' && 'text-blocked', item.status === 'warn' && 'text-paused')}>{item.label}</span>
          <CheckInfo id={item.id} description={description} className="-my-1" />
          <Chip variant={item.enforcement} tone={TONE[item.status]} className="py-1">
            {item.enforcement === 'chain' ? 'chain' : 'agent'}
          </Chip>
          {item.status === 'skip' ? <span className="text-xs text-dim">skipped</span> : null}
          {canToggle ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="-my-1 ml-auto text-dim hover:text-text"
              aria-expanded={expanded}
              aria-controls={showDetails ? detailsId : undefined}
              aria-label={expanded ? 'Show less' : 'Show more'}
              onClick={handleToggle}
            >
              <ChevronDown aria-hidden className={cn('transition-transform', expanded && 'rotate-180')} />
            </Button>
          ) : null}
        </div>
        {showDetails ? (
          <div id={detailsId}>
            {item.evidence ? (
              <p ref={evidenceRef} className={cn('mt-1 text-xs leading-relaxed text-secondary-foreground', clamp ? 'line-clamp-2' : 'break-words')}>
                {item.evidence}
              </p>
            ) : null}
            {item.source ? (
              <p ref={sourceRef} className={cn('mt-1 text-xs text-dim', clamp ? 'truncate' : 'break-words')} title={clamp ? item.source : undefined}>
                {item.source}
              </p>
            ) : null}
          </div>
        ) : null}
        {item.status === 'running' ? <p className="mt-1 text-xs text-dim">checking…</p> : null}
      </div>
    </div>
  )
}
