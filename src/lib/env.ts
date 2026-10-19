// Server-only env access. Never import from client components.
if (typeof window !== 'undefined') {
  throw new Error('src/lib/env.ts is server-only')
}

const DEFAULT_SEPOLIA_RPC = 'https://ethereum-sepolia-rpc.publicnode.com'

/** Which rail sends the EURC: Thyme Flow, or labelled fake payouts when Thyme is not configured. */
export type PaymentExecutorName = 'thyme' | 'simulated'

export function env(name: string, fallback = ''): string {
  const v = process.env[name]
  return v === undefined || v === '' ? fallback : v
}

export function envInt(name: string, fallback: number): number {
  const n = Number.parseInt(env(name), 10)
  return Number.isFinite(n) ? n : fallback
}

export const serverEnv = {
  databasePath: () => env('DATABASE_PATH', './data/payroll.sqlite'),
  sepoliaRpcUrl: () => env('SEPOLIA_RPC_URL', DEFAULT_SEPOLIA_RPC),
  llmProvider: () => env('LLM_PROVIDER', 'mock') as 'bedrock' | 'anthropic' | 'mock',
  /** PAYMENT_EXECUTOR: 'thyme' (default) or 'simulated'. Anything else is read as 'simulated'. */
  paymentExecutor: (): PaymentExecutorName => (env('PAYMENT_EXECUTOR', 'thyme').toLowerCase() === 'thyme' ? 'thyme' : 'simulated'),
  autoPayThreshold: () => envInt('AUTO_PAY_THRESHOLD', 100),
  thymePullToken: () => env('THYME_PULL_TOKEN'),
  appUrl: () => env('APP_URL', 'http://localhost:3000'),
}

/** Safe to ship to the browser. Public RPC and WalletConnect project id only. */
export function publicConfig() {
  return {
    walletConnectProjectId: env('VITE_WALLETCONNECT_PROJECT_ID') || null,
    rpcUrl: serverEnv.sepoliaRpcUrl(),
    paymentExecutor: serverEnv.paymentExecutor(),
    llmProvider: serverEnv.llmProvider(),
    autoPayThreshold: serverEnv.autoPayThreshold(),
  }
}
