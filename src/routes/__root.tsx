import { HeadContent, Outlet, Scripts, createRootRouteWithContext, useLocation } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import type { ReactNode } from 'react'
import { Tour } from '@/components/demo/Tour'
import { Shell } from '@/components/shell/Shell'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { WalletProvider } from '@/components/wallet/WalletProvider'
import { getDemoState } from '@/lib/server/demo.fns'
import type { RouterContext } from '@/router'
import appCss from '@/styles/app.css?url'

/** Public, non-secret runtime config read on the server (Railway variables), so no build args are needed. */
const getPublicConfig = createServerFn({ method: 'GET' }).handler(async () => {
  const [{ publicConfig }, { ensureBooted }] = await Promise.all([import('@/lib/env'), import('@/lib/server/boot')])
  ensureBooted()
  return publicConfig()
})

export const Route = createRootRouteWithContext<RouterContext>()({
  loader: async () => {
    const [config, demo] = await Promise.all([getPublicConfig(), getDemoState()])
    return { ...config, demo }
  },
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { name: 'theme-color', content: '#0b0b0c' },
      { title: 'Thyme Payroll' },
      { name: 'description', content: 'Budgets agents cannot break. EURC payroll with on-chain limits.' },
    ],
    links: [
      { rel: 'stylesheet', href: appCss },
      { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' },
    ],
  }),
  shellComponent: RootDocument,
  component: RootComponent,
})

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  )
}

function RootComponent() {
  const config = Route.useLoaderData()
  const { pathname } = useLocation()
  const bare = pathname === '/'
  return (
    <WalletProvider walletConnectProjectId={config.walletConnectProjectId} rpcUrl={config.rpcUrl}>
      <TooltipProvider delayDuration={200}>
        <Shell bare={bare}>
          <Outlet />
        </Shell>
        <Tour demo={config.demo} />
        <Toaster position="bottom-right" />
      </TooltipProvider>
    </WalletProvider>
  )
}
