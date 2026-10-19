import { Info } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { type CheckDescription, describeCheck } from '@/lib/agent/descriptions/checks'
import { cn } from '@/lib/utils'

interface CheckInfoProps {
  /** Check id used to look the description up; ignored when `description` is given. */
  id: string
  /** Explicit description (overrides the lookup by id). */
  description?: CheckDescription | null
  className?: string
}

const ENFORCEMENT_TEXT: Record<CheckDescription['enforcement'], string> = {
  chain: 'On chain, by the Roles conditions on the Safe.',
  agent: 'By the agent, before Thyme is asked to pay.',
}

/** Info icon with a tooltip: what the check does, which data it reads, who enforces it, why it matters. */
export function CheckInfo({ id, description, className }: CheckInfoProps) {
  const d = description === undefined ? describeCheck(id) : description
  if (!d) return null
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button type="button" variant="ghost" size="icon-xs" className={cn('text-dim hover:text-text', className)} aria-label={`About the ${d.title} check`}>
          <Info aria-hidden />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" align="start" className="max-w-xs p-3 text-left text-pretty leading-relaxed">
        <div className="grid gap-1.5">
          <div className="font-medium">{d.title}</div>
          <p>{d.what}</p>
          <p>
            <span className="opacity-70">Data: </span>
            {d.data}
          </p>
          <p>
            <span className="opacity-70">Enforced: </span>
            {ENFORCEMENT_TEXT[d.enforcement]}
          </p>
          <p>
            <span className="opacity-70">Why it matters: </span>
            {d.whyItMatters}
          </p>
        </div>
      </TooltipContent>
    </Tooltip>
  )
}
