import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { Rail } from './Rail'

interface ShellProps {
  children: ReactNode
  bare?: boolean
}

/** App frame. `bare` hides the rail (connect screen). */
export function Shell({ children, bare = false }: ShellProps) {
  if (bare) return <div className="min-h-screen">{children}</div>
  return (
    <div className="min-h-screen">
      <Rail />
      <main className={cn('mx-auto max-w-6xl px-10 pt-14 pb-14 pl-28 lg:px-14 lg:pl-32')}>{children}</main>
    </div>
  )
}

interface PageHeaderProps {
  eyebrow?: ReactNode
  title: ReactNode
  actions?: ReactNode
  className?: string
}

export function PageHeader({ eyebrow, title, actions, className }: PageHeaderProps) {
  return (
    <header className={cn('flex items-start justify-between gap-6', className)}>
      <div>
        {eyebrow ? <div className="text-xs text-dim">{eyebrow}</div> : null}
        <h1 className="mt-1 text-3xl font-medium tracking-tightest">{title}</h1>
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </header>
  )
}

export function Section({ title, aside, children, className }: { title: ReactNode; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn('mt-10', className)}>
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-base font-medium">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  )
}
