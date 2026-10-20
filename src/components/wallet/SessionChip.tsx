import { useQuery } from '@tanstack/react-query'
import { LogOut } from 'lucide-react'
import { useAccountEffect, useDisconnect } from 'wagmi'
import { fetchSession, signOut } from '@/lib/auth/siwe'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

const SESSION_QUERY_KEY = ['session'] as const

/** Rail-bottom signed-in chip: the tenant label (short address or demo-xxxxxx) and a sign-out button. */
export function SessionChip() {
  const session = useQuery({ queryKey: SESSION_QUERY_KEY, queryFn: fetchSession, staleTime: 30_000 })
  const { disconnect } = useDisconnect()

  // A full reload: every loader on the current page is tenant-scoped and would otherwise
  // race the redirect with 401s. The wallet is disconnected first so the connect page does
  // not bounce straight back to the dashboard.
  async function handleSignOut() {
    disconnect()
    await signOut()
    window.location.assign('/')
  }

  // Disconnecting from the wallet UI (ConnectKit / MetaMask) ends a wallet session too.
  useAccountEffect({
    onDisconnect() {
      if (session.data?.kind !== 'wallet') return
      void signOut().then(() => window.location.assign('/'))
    },
  })

  if (!session.data) return null
  const title = session.data.kind === 'wallet' ? `Signed in as ${session.data.address}` : `Demo session ${session.data.label} (simulated payouts)`
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={handleSignOut}
          aria-label={`${title}. Sign out`}
          className="flex w-16 flex-col items-center gap-1 rounded-lg px-1 py-1.5 font-mono text-xs text-dim transition-colors hover:bg-raised hover:text-text"
        >
          <span className="max-w-full truncate">{session.data.label}</span>
          <LogOut aria-hidden className="size-3.5" strokeWidth={1.5} />
        </button>
      </TooltipTrigger>
      <TooltipContent side="right" className="text-xs">
        {title} · click to sign out
      </TooltipContent>
    </Tooltip>
  )
}
