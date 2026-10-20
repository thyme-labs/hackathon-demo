// Client-side session helpers: Sign-In with Ethereum (EIP-4361 message signed by the connected wallet) and the
// anonymous demo session. Talks to /api/auth/*; the session itself is an httpOnly cookie the browser carries.

export interface SessionInfo {
  tenant: string
  kind: 'wallet' | 'anon'
  address: string | null
  label: string
  expiresAt: string
}

export const SIWE_CHAIN_ID = 11155111
const SIWE_STATEMENT = 'Sign in to Thyme Payroll. This signature only proves you own this wallet; it costs no gas and moves no funds.'

export function buildSiweMessage(input: { domain: string; address: string; uri: string; nonce: string; issuedAt: string; expirationTime: string }): string {
  return [
    `${input.domain} wants you to sign in with your Ethereum account:`,
    input.address,
    '',
    SIWE_STATEMENT,
    '',
    `URI: ${input.uri}`,
    'Version: 1',
    `Chain ID: ${SIWE_CHAIN_ID}`,
    `Nonce: ${input.nonce}`,
    `Issued At: ${input.issuedAt}`,
    `Expiration Time: ${input.expirationTime}`,
  ].join('\n')
}

async function readJson<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => null)) as (T & { error?: string }) | null
  if (!res.ok) throw new Error(body?.error ?? `${res.status} ${res.statusText}`)
  return body as T
}

export async function fetchSession(): Promise<SessionInfo | null> {
  const res = await fetch('/api/auth/me', { credentials: 'same-origin', cache: 'no-store' })
  const body = await readJson<{ session: SessionInfo | null }>(res)
  return body.session
}

/** Full SIWE round trip: nonce, message, wallet signature, verify. `signMessage` is wagmi's signMessageAsync. */
export async function signInWithWallet(address: string, signMessage: (args: { message: string }) => Promise<string>): Promise<SessionInfo> {
  const nonceRes = await fetch('/api/auth/nonce', { method: 'POST', credentials: 'same-origin' })
  const { nonce } = await readJson<{ nonce: string }>(nonceRes)
  const now = Date.now()
  const message = buildSiweMessage({
    domain: window.location.host,
    address,
    uri: window.location.origin,
    nonce,
    issuedAt: new Date(now).toISOString(),
    expirationTime: new Date(now + 5 * 60_000).toISOString(),
  })
  const signature = await signMessage({ message })
  const verifyRes = await fetch('/api/auth/verify', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message, signature }),
  })
  const body = await readJson<{ session: SessionInfo }>(verifyRes)
  return body.session
}

export async function continueWithoutWallet(): Promise<SessionInfo> {
  const res = await fetch('/api/auth/anonymous', { method: 'POST', credentials: 'same-origin' })
  const body = await readJson<{ session: SessionInfo }>(res)
  return body.session
}

export async function signOut(): Promise<void> {
  await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' })
}
