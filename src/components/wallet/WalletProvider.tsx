import { ConnectKitProvider } from 'connectkit'
import type { ReactNode } from 'react'
import { WagmiProvider } from 'wagmi'
import { getWagmiConfig, type WalletOptions } from '@/lib/wallet/wagmi'

interface WalletProviderProps extends WalletOptions {
  children: ReactNode
}

const connectKitTheme = {
  '--ck-font-family': 'Inter, ui-sans-serif, system-ui, sans-serif',
  '--ck-border-radius': '12px',
  '--ck-overlay-background': 'rgba(0, 0, 0, 0.6)',
  '--ck-overlay-backdrop-filter': 'blur(4px)',
  '--ck-body-background': '#171719',
  '--ck-body-background-secondary': '#1a1a1d',
  '--ck-body-background-tertiary': '#131315',
  '--ck-body-color': '#ededed',
  '--ck-body-color-muted': '#8a8a8f',
  '--ck-body-color-muted-hover': '#ededed',
  '--ck-body-divider': 'rgba(255,255,255,0.06)',
  '--ck-primary-button-background': '#1a1a1d',
  '--ck-primary-button-hover-background': '#222226',
  '--ck-primary-button-color': '#ededed',
  '--ck-primary-button-border-radius': '8px',
  '--ck-secondary-button-background': '#1a1a1d',
  '--ck-secondary-button-color': '#ededed',
  '--ck-focus-color': 'oklch(0.65 0.08 165)',
  '--ck-spinner-color': 'oklch(0.65 0.08 165)',
  '--ck-modal-box-shadow': '0 30px 100px rgba(0,0,0,0.5)',
  '--ck-qr-dot-color': '#ededed',
  '--ck-qr-background': '#131315',
  '--ck-qr-border-color': 'rgba(255,255,255,0.06)',
  '--ck-tooltip-background': '#1a1a1d',
  '--ck-tooltip-color': '#ededed',
  '--ck-connectbutton-background': '#1a1a1d',
  '--ck-connectbutton-color': '#ededed',
  '--ck-connectbutton-hover-background': '#222226',
}

/** Wagmi + ConnectKit. The QueryClientProvider comes from the router's ssr-query integration. */
export function WalletProvider({ children, walletConnectProjectId, rpcUrl }: WalletProviderProps) {
  const config = getWagmiConfig({ walletConnectProjectId, rpcUrl })
  return (
    <WagmiProvider config={config}>
      <ConnectKitProvider
        mode="dark"
        customTheme={connectKitTheme}
        options={{ initialChainId: 11155111, hideBalance: true, enforceSupportedChains: true }}
      >
        {children}
      </ConnectKitProvider>
    </WagmiProvider>
  )
}
