import { cn } from '@/lib/utils'

interface LogoProps {
  className?: string
}

/** Thyme leaf mark. */
export function Logo({ className }: LogoProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={cn('size-7 text-sage', className)}
    >
      <path d="M19 4C9 3 4 7 5 14c1 6 12 7 14-10Z" />
      <path d="m6 18 8-9" />
    </svg>
  )
}
