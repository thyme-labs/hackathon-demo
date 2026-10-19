import { cn } from '@/lib/utils'
import { CheckItem, type CheckItemData } from './CheckItem'

type Group = 'fail' | 'warn' | 'pass' | 'skip' | 'running' | 'pending'

/** Severity order: failed first, then warnings, passes, skips; checks still running or pending close the list. */
const GROUP_ORDER: Group[] = ['fail', 'warn', 'pass', 'skip', 'running', 'pending']

const GROUP_LABEL: Record<Group, string> = {
  fail: 'Failed',
  warn: 'Warnings',
  pass: 'Passed',
  skip: 'Skipped',
  running: 'Checking',
  pending: 'Waiting',
}

const GROUP_TONE: Record<Group, string> = {
  fail: 'text-blocked',
  warn: 'text-paused',
  pass: 'text-sage',
  skip: 'text-dim',
  running: 'text-dim',
  pending: 'text-dim/60',
}

export interface CheckGroup<T extends CheckItemData> {
  group: Group
  label: string
  items: T[]
}

/** Groups by severity (fail, warn, pass, skip, running, pending); stable within a group by the original check order. */
export function groupChecksBySeverity<T extends CheckItemData>(entries: readonly T[]): CheckGroup<T>[] {
  return GROUP_ORDER.flatMap((group) => {
    const items = entries.filter((e) => e.status === group)
    return items.length > 0 ? [{ group, label: GROUP_LABEL[group], items }] : []
  })
}

/** Flat severity-sorted list (same order as groupChecksBySeverity) for callers that render their own rows. */
export function sortChecksBySeverity<T extends CheckItemData>(entries: readonly T[]): T[] {
  return groupChecksBySeverity(entries).flatMap((g) => g.items)
}

interface CheckListProps<T extends CheckItemData> {
  entries: readonly T[]
  /** Hide evidence and source until a row is expanded (compact tables). */
  compact?: boolean
  /** Hide the small group headers and only keep the divider between groups. */
  headers?: boolean
  className?: string
}

/** Checklist sorted by severity with a small header (or a thin divider) between the groups. */
export function CheckList<T extends CheckItemData>({ entries, compact = false, headers = true, className }: CheckListProps<T>) {
  const groups = groupChecksBySeverity(entries)
  return (
    <div className={cn('grid', className)}>
      {groups.map((g, index) => (
        <section key={g.group} aria-label={g.label} className={cn(index > 0 && 'mt-2 border-t border-hairline pt-2')}>
          {headers ? (
            <div className={cn('flex items-center gap-2 pt-1 text-xs', GROUP_TONE[g.group])}>
              <span className="font-medium">{g.label}</span>
              <span className="text-dim">{g.items.length}</span>
            </div>
          ) : null}
          <div>
            {g.items.map((item) => (
              <CheckItem key={item.id} item={item} compact={compact} />
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}
