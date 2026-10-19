import { useNavigate } from '@tanstack/react-router'
import { useModal } from 'connectkit'
import { useEffect } from 'react'
import { useAccount } from 'wagmi'
import { Logo } from '@/components/shell/Logo'
import { StatusDot } from '@/components/ui-kit/StatusDot'
import { Button } from '@/components/ui/button'

/** Landing: wordmark, headline, Connect wallet / Safe{Wallet}, Sepolia pill. Redirects once connected. */
export function ConnectPage() {
  const { isConnected } = useAccount()
  const { setOpen } = useModal()
  const navigate = useNavigate()

  useEffect(() => {
    if (isConnected) void navigate({ to: '/dashboard' })
  }, [isConnected, navigate])

  function handleConnect() {
    setOpen(true)
  }

  function handleSafe() {
    // Safe{Wallet} connects through WalletConnect; the same modal shows the QR / URI.
    setOpen(true)
  }

  function handleSkip() {
    void navigate({ to: '/dashboard' })
  }

  return (
    <main className="flex min-h-screen items-center justify-center text-center">
      <div className="-translate-y-4">
        <div className="flex items-center justify-center gap-3 text-2xl font-medium tracking-tightest">
          <Logo />
          thyme
        </div>
        <h1 className="mt-9 mb-8 text-5xl font-normal tracking-tightest">Budgets agents can't break.</h1>
        <div className="flex justify-center gap-2.5">
          <Button size="lg" className="min-w-36" onClick={handleConnect}>
            Connect wallet
          </Button>
          <Button size="lg" variant="secondary" className="min-w-36" onClick={handleSafe}>
            Safe{'{Wallet}'}
          </Button>
        </div>
        <div className="mt-8 inline-flex items-center gap-2 rounded-full bg-surface px-2.5 py-1.5 text-xs text-dim">
          <StatusDot tone="ok" className="size-1" />
          Sepolia
        </div>
        <div className="mt-6">
          <Button variant="link" size="sm" className="text-dim" onClick={handleSkip}>
            Continue without a wallet
          </Button>
        </div>
      </div>
    </main>
  )
}
