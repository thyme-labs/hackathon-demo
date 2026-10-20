import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { LogOut } from 'lucide-react'
import { useDisconnect } from 'wagmi'
import { fetchSession, signOut } from '@/lib/auth/siwe'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

const SESSION_QUERY_KEY = ['session'] as const

/** Rail-bottom signed-in chip: the tenant label (short address or demo-xxxxxx) and a sign-out button. */
export function SessionChip() {
  const session = useQuery({ queryKey: SESSION_QUERY_KEY, queryFn: fetchSession, staleTime: 30_000 })
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const { disconnect } = useDisconnect()

  async function handleSignOut() {
    await signOut()
    disconnect()
    queryClient.setQueryData(SESSION_QUERY_KEY, null)
    await queryClient.invalidateQueries()
    void navigate({ to: '/' })
  }

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
