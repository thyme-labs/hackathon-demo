import { useModal } from 'connectkit'
import { useAccount } from 'wagmi'
import { cn } from '@/lib/utils'
import { shortAddress } from '@/lib/wallet/wagmi'
import { StatusDot } from '@/components/ui-kit/StatusDot'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

interface WalletChipProps {
  className?: string
}

/** Rail-bottom wallet avatar. Click opens ConnectKit (connect or account view). */
export function WalletChip({ className }: WalletChipProps) {
  const { address, isConnected, chainId } = useAccount()
  const { setOpen } = useModal()
  const onSepolia = chainId === 11155111
  const label = isConnected && address ? shortAddress(address) : 'Connect wallet'

  function handleClick() {
    setOpen(true)
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={handleClick}
          aria-label={label}
          className={cn(
            'grid size-9 place-items-center rounded-full border-4 border-raised transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-sage',
            isConnected ? 'bg-conic-60 from-sage/70 via-sage/30 to-sage/70' : 'bg-raised',
            className,
          )}
        >
          {!isConnected ? <StatusDot tone="idle" className="size-1.5" /> : null}
        </button>
      </TooltipTrigger>
      <TooltipContent side="right" className="font-mono text-xs">
        {label}
        {isConnected && !onSepolia ? ' · wrong network' : ''}
      </TooltipContent>
    </Tooltip>
  )
}
