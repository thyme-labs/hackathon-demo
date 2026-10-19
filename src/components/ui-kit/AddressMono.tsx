import { Check, Copy, ExternalLink } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { etherscanAddress, etherscanTx, shortAddress } from '@/lib/wallet/wagmi'

interface AddressMonoProps {
  value: string
  kind?: 'address' | 'tx'
  head?: number
  tail?: number
  copy?: boolean
  link?: boolean
  className?: string
}

/** Truncated hex in mono with copy and Etherscan (Sepolia) link. */
export function AddressMono({ value, kind = 'address', head = 6, tail = 4, copy = true, link = true, className }: AddressMonoProps) {
  const [copied, setCopied] = useState(false)
  const href = kind === 'tx' ? etherscanTx(value) : etherscanAddress(value)

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch {
      toast.error('Clipboard unavailable')
    }
  }

  return (
    <span className={cn('inline-flex items-center gap-1.5 font-mono text-xs text-secondary-foreground', className)}>
      <span title={value}>{shortAddress(value, head, tail)}</span>
      {copy ? (
        <button
          type="button"
          onClick={handleCopy}
          aria-label="Copy"
          className="rounded-sm p-0.5 text-dim transition-colors hover:text-text"
        >
          {copied ? <Check aria-hidden className="size-3 text-sage" /> : <Copy aria-hidden className="size-3" />}
        </button>
      ) : null}
      {link ? (
        <a
          href={href}
          target="_blank"
          rel="noreferrer noopener"
          aria-label="Open on Etherscan"
          className="rounded-sm p-0.5 text-dim transition-colors hover:text-text"
        >
          <ExternalLink aria-hidden className="size-3" />
        </a>
      ) : null}
    </span>
  )
}
