import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useRouter } from '@tanstack/react-router'
import { useModal } from 'connectkit'
import { Sparkles } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useAccount, useSignMessage } from 'wagmi'
import { Logo } from '@/components/shell/Logo'
import { StatusDot } from '@/components/ui-kit/StatusDot'
import { Button } from '@/components/ui/button'
import { continueWithoutWallet, fetchSession, signInWithWallet } from '@/lib/auth/siwe'
import { tourStore } from '@/lib/demo/tourStore'
import { startJuryDemo } from '@/lib/server/demo.fns'
import { shortAddress } from '@/lib/wallet/wagmi'

export const SESSION_QUERY_KEY = ['session'] as const

/**
 * Landing: wordmark, headline, Connect wallet / Safe{Wallet}, Sepolia pill. A connected wallet still has to sign in
 * (Sign-In with Ethereum) so the server knows which tenant it is; "Continue without a wallet" opens a demo tenant.
 */
export function ConnectPage() {
  const { isConnected, address } = useAccount()
  const { signMessageAsync } = useSignMessage()
  const { setOpen } = useModal()
  const navigate = useNavigate()
  const router = useRouter()
  const queryClient = useQueryClient()
  const session = useQuery({ queryKey: SESSION_QUERY_KEY, queryFn: fetchSession, staleTime: 0 })
  const [busy, setBusy] = useState<'sign' | 'anon' | 'jury' | null>(null)

  const signedInHere = Boolean(session.data && address && session.data.address?.toLowerCase() === address.toLowerCase())

  useEffect(() => {
    if (isConnected && signedInHere) void navigate({ to: '/dashboard' })
  }, [isConnected, signedInHere, navigate])

  function handleConnect() {
    setOpen(true)
  }

  function handleSafe() {
    // Safe{Wallet} connects through WalletConnect; the same modal shows the QR / URI.
    setOpen(true)
  }

  async function handleSignIn() {
    if (!address) return
    setBusy('sign')
    try {
      const next = await signInWithWallet(address, signMessageAsync)
      queryClient.setQueryData(SESSION_QUERY_KEY, next)
      void navigate({ to: '/dashboard' })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Sign-in failed')
    } finally {
      setBusy(null)
    }
  }

  async function handleSkip() {
    setBusy('anon')
    try {
      const next = await continueWithoutWallet()
      queryClient.setQueryData(SESSION_QUERY_KEY, next)
      void navigate({ to: '/dashboard' })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not start a demo session')
    } finally {
      setBusy(null)
    }
  }

  /** Demo tenant with seeded data and the guided walkthrough; real tenants never see the tour. */
  async function handleJuryDemo() {
    setBusy('jury')
    try {
      const result = await startJuryDemo()
      queryClient.setQueryData(SESSION_QUERY_KEY, result.session)
      await queryClient.invalidateQueries()
      tourStore.start(0)
      await router.invalidate()
      void navigate({ to: '/dashboard', search: { tour: 1 } })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not start the jury demo')
    } finally {
      setBusy(null)
    }
  }

  const showSignIn = isConnected && address && !signedInHere

  return (
    <main className="flex min-h-screen items-center justify-center text-center">
      <div className="-translate-y-4">
        <div className="flex items-center justify-center gap-3 text-2xl font-medium tracking-tightest">
          <Logo />
          thyme
        </div>
        <h1 className="mt-9 mb-8 text-5xl font-normal tracking-tightest">Budgets agents can't break.</h1>
        {showSignIn ? (
          <div className="flex flex-col items-center gap-3">
            <div className="text-sm text-dim">
              Connected as <span className="font-mono">{shortAddress(address)}</span>. Sign a message to open your workspace.
            </div>
            <Button size="lg" className="min-w-48" onClick={handleSignIn} disabled={busy !== null}>
              {busy === 'sign' ? 'Waiting for the wallet…' : 'Sign in with wallet'}
            </Button>
          </div>
        ) : (
          <div className="flex justify-center gap-2.5">
            <Button size="lg" className="min-w-36" onClick={handleConnect}>
              Connect wallet
            </Button>
            <Button size="lg" variant="secondary" className="min-w-36" onClick={handleSafe}>
              Safe{'{Wallet}'}
            </Button>
            <Button size="lg" variant="secondary" className="min-w-36" onClick={handleJuryDemo} disabled={busy !== null} title="Open a demo workspace with sample data and a guided walkthrough">
              <Sparkles aria-hidden />
              {busy === 'jury' ? 'Preparing…' : 'Jury demo'}
            </Button>
          </div>
        )}
        <div className="mt-8 inline-flex items-center gap-2 rounded-full bg-surface px-2.5 py-1.5 text-xs text-dim">
          <StatusDot tone="ok" className="size-1" />
          Sepolia
        </div>
        <div className="mt-6">
          <Button variant="link" size="sm" className="text-dim" onClick={handleSkip} disabled={busy !== null}>
            {busy === 'anon' ? 'Starting a demo…' : 'Continue without a wallet'}
          </Button>
        </div>
      </div>
    </main>
  )
}
