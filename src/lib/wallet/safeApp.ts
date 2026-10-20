// Safe{Wallet} Safe App support. Inside the app.safe.global iframe the wagmi `safe` connector talks to the
// host over postMessage and the connected account is the Safe itself (never an owner EOA); outside the
// iframe the connector has no provider and everything here is a no-op.
import { useEffect, useRef } from 'react'
import { type Address, decodeFunctionData, getAddress, type Hex, type PublicClient } from 'viem'
import { useAccount, useConnect, useConnectors } from 'wagmi'
import { safeAbi } from '@/lib/roles/abi'

export const SAFE_CONNECTOR_ID = 'safe'

/** Shown when the prepared setup cannot be sent from inside Safe{Wallet}. */
export const OWNER_WALLET_SETUP_MESSAGE =
  "This one-time setup is a batch (delegatecall to MultiSend) that a Safe App cannot send on behalf of the Safe: open this app from the owner's MetaMask for the one-time setup, then come back to Safe{Wallet} for payroll."

/** Safe.execTransaction selector; the owner-broadcast setup always starts with it. */
const EXEC_TRANSACTION_SELECTOR = '0x6a761202'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** True when the document is embedded (Safe{Wallet} loads Safe Apps in an iframe). */
export function isInIframe(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.parent !== window
  } catch {
    return true
  }
}

/** Connected through the Safe connector: `useAccount().address` is the Safe, not one of its owners. */
export function useIsSafeApp(): boolean {
  const { connector, isConnected } = useAccount()
  return isConnected && connector?.id === SAFE_CONNECTOR_ID
}

/**
 * Inside the Safe{Wallet} iframe, connect once through the `safe` connector as soon as wagmi has finished
 * its own reconnect pass and nothing is connected. MetaMask / WalletConnect paths are untouched.
 */
export function useSafeAppAutoConnect(): void {
  const { status } = useAccount()
  const connectors = useConnectors()
  const { connectAsync } = useConnect()
  const attempted = useRef(false)

  useEffect(() => {
    if (attempted.current || status !== 'disconnected' || !isInIframe()) return
    const connector = connectors.find((c) => c.id === SAFE_CONNECTOR_ID)
    if (!connector) return
    attempted.current = true
    connector
      .getProvider()
      .then((provider) => (provider ? connectAsync({ connector }) : undefined))
      .catch(() => {
        // Not a Safe{Wallet} host (plain iframe) or the host refused: leave the regular connect flow in place.
      })
  }, [status, connectors, connectAsync])
}

export type InnerSafeTx = { to: Address; value: bigint; data: Hex; operation: number }

/** Unwrap Safe.execTransaction(to, value, data, operation, ...) calldata into the call the Safe would execute. */
export function decodeExecTransaction(data: Hex): InnerSafeTx {
  const decoded = decodeFunctionData({ abi: safeAbi, data })
  if (decoded.functionName !== 'execTransaction') throw new Error(`Expected Safe.execTransaction calldata, got ${decoded.functionName}`)
  const [to, value, inner, operation] = decoded.args
  return { to: getAddress(to), value, data: inner, operation: Number(operation) }
}

export type SafeAppSetup = { ok: true; inner: InnerSafeTx } | { ok: false; reason: string }

/**
 * What a Safe App can do with Thyme's prepared owner transaction. The Safe cannot call its own execTransaction,
 * so the inner call is queued as a Safe transaction instead; only a plain CALL (operation 0) can be expressed
 * that way. A MultiSend batch is a delegatecall and needs the owner's own wallet.
 */
export function inspectSafeAppSetup(data: Hex): SafeAppSetup {
  let inner: InnerSafeTx
  try {
    inner = decodeExecTransaction(data)
  } catch (error) {
    return { ok: false, reason: `Could not decode the prepared transaction (${describe(error)}). ${OWNER_WALLET_SETUP_MESSAGE}` }
  }
  if (inner.operation !== 0) return { ok: false, reason: OWNER_WALLET_SETUP_MESSAGE }
  return { ok: true, inner }
}

type Eip1193Like = { request(args: { method: string; params?: unknown[] }): Promise<unknown> }
type SafeAppsSdkLike = { txs: { getBySafeTxHash(safeTxHash: string): Promise<{ txStatus: string; txHash?: string | null }> } }

function asEip1193(provider: unknown): Eip1193Like | null {
  return provider && typeof (provider as Eip1193Like).request === 'function' ? (provider as Eip1193Like) : null
}

/** The Safe Apps SDK behind the connector's SafeAppProvider (kept as an instance field). */
function sdkOf(provider: unknown): SafeAppsSdkLike | null {
  const sdk = (provider as { sdk?: SafeAppsSdkLike } | null)?.sdk
  return sdk && typeof sdk.txs?.getBySafeTxHash === 'function' ? sdk : null
}

export interface WaitForSafeTxOptions {
  /** Provider of the wagmi Safe connector (`connector.getProvider()`). */
  provider: unknown
  publicClient: PublicClient
  safe: Address
  /** What `sendTransaction` returned through the Safe connector: a Safe tx hash, not an on-chain hash. */
  safeTxHash: Hex
  attempts?: number
  intervalMs?: number
}

/**
 * Wait until Safe{Wallet} has executed the queued Safe transaction and return the on-chain hash. The Safe
 * provider answers receipts under the Safe tx hash, so the real hash comes from the SDK's transaction
 * details, or failing that from the block the receipt points at.
 */
export async function waitForSafeTxExecution({ provider, publicClient, safe, safeTxHash, attempts = 180, intervalMs = 5_000 }: WaitForSafeTxOptions): Promise<Hex> {
  const sdk = sdkOf(provider)
  const eip1193 = asEip1193(provider)
  if (!sdk && !eip1193) throw new Error('Safe App provider unavailable: open this app from Safe{Wallet}')

  for (let attempt = 0; attempt < attempts; attempt++) {
    if (sdk) {
      const details = await sdk.txs.getBySafeTxHash(safeTxHash).catch(() => null)
      if (details?.txStatus === 'SUCCESS' && details.txHash) return details.txHash as Hex
      if (details?.txStatus === 'FAILED') throw new Error('The Safe transaction failed on chain; nothing was installed on the Safe')
      if (details?.txStatus === 'CANCELLED') throw new Error('The Safe transaction was cancelled in Safe{Wallet}')
    } else if (eip1193) {
      const receipt = (await eip1193.request({ method: 'eth_getTransactionReceipt', params: [safeTxHash] }).catch(() => null)) as { blockHash?: Hex; status?: Hex } | null
      if (receipt?.blockHash) {
        if (receipt.status !== '0x1') throw new Error('The Safe transaction failed on chain; nothing was installed on the Safe')
        const hash = await findExecTransactionInBlock(publicClient, receipt.blockHash, safe)
        if (hash) return hash
        throw new Error(`The Safe transaction was executed in block ${receipt.blockHash} but its hash could not be read; enter it below.`)
      }
    }
    await sleep(intervalMs)
  }
  throw new Error(`Safe transaction ${safeTxHash} is still queued in Safe{Wallet}. Execute it there, then enter the on-chain hash below.`)
}

/** The execTransaction call to `safe` inside a block (Safe{Wallet} executes exactly one per Safe tx). */
async function findExecTransactionInBlock(publicClient: PublicClient, blockHash: Hex, safe: Address): Promise<Hex | null> {
  const block = await publicClient.getBlock({ blockHash, includeTransactions: true })
  const match = block.transactions.find((tx) => tx.to?.toLowerCase() === safe.toLowerCase() && tx.input.startsWith(EXEC_TRANSACTION_SELECTOR))
  return match?.hash ?? null
}
