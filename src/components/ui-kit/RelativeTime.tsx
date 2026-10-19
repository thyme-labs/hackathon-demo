import { useEffect, useState } from 'react'
import { formatDateTime, formatRelative } from './format'

/** Absolute time on the server (deterministic), relative "3m ago" on the client after mount. */
export function RelativeTime({ iso, className }: { iso: string | null | undefined; className?: string }) {
  const [text, setText] = useState(() => (iso ? formatDateTime(iso) : 'never'))
  useEffect(() => {
    const update = () => setText(formatRelative(iso))
    update()
    const timer = setInterval(update, 10_000)
    return () => clearInterval(timer)
  }, [iso])
  return (
    <time dateTime={iso ?? undefined} className={className}>
      {text}
    </time>
  )
}
