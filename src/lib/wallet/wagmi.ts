import { createConfig, createStorage, cookieStorage, http } from 'wagmi'
import { sepolia } from 'wagmi/chains'
import { injected, walletConnect } from 'wagmi/connectors'

export const CHAIN = sepolia
export const ETHERSCAN = 'https://sepolia.etherscan.io'

export interface WalletOptions {
  walletConnectProjectId?: string | null
  rpcUrl?: string | null
}

let cached: { key: string; config: ReturnType<typeof createConfig> } | null = null

/**
 * Sepolia-only wagmi config. Injected (MetaMask, Rabby, ...) always; WalletConnect only in the
 * browser and only when a project id is configured. Safe{Wallet} connects through WalletConnect.
 */
export function getWagmiConfig(opts: WalletOptions = {}) {
  const inBrowser = typeof window !== 'undefined'
  const projectId = opts.walletConnectProjectId ?? import.meta.env.VITE_WALLETCONNECT_PROJECT_ID ?? ''
  const key = `${inBrowser ? 'b' : 's'}:${projectId}:${opts.rpcUrl ?? ''}`
  if (cached && cached.key === key) return cached.config

  const connectors = [injected({ shimDisconnect: true })]
  if (inBrowser && projectId) {
    connectors.push(
      walletConnect({
        projectId,
        showQrModal: true,
        metadata: {
          name: 'Thyme Payroll',
          description: 'Budgets agents cannot break.',
          url: window.location.origin,
          icons: [`${window.location.origin}/favicon.svg`],
        },
      }) as unknown as ReturnType<typeof injected>,
    )
  }

  const config = createConfig({
    chains: [sepolia],
    connectors,
    ssr: true,
    storage: createStorage({ storage: cookieStorage }),
    transports: {
      [sepolia.id]: http(opts.rpcUrl || undefined),
    },
  })
  cached = { key, config }
  return config
}

export function shortAddress(address: string, head = 6, tail = 4): string {
  if (address.length <= head + tail + 1) return address
  return `${address.slice(0, head)}…${address.slice(-tail)}`
}

export function etherscanAddress(address: string): string {
  return `${ETHERSCAN}/address/${address}`
}

export function etherscanTx(hash: string): string {
  return `${ETHERSCAN}/tx/${hash}`
}
