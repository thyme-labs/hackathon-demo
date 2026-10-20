// Server-only sessions. Sign-In with Ethereum (EIP-4361 message signed by the connected wallet, verified with
// viem) or an anonymous demo session. The session is an HMAC-signed token in the httpOnly cookie `tp_session`;
// the tenant id is the lower-case owner address ('anon:<id>' for demo sessions). SESSION_SECRET signs the
// token; without it a random secret is generated once and kept in the settings table (tenant '_global').
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { redirect } from '@tanstack/react-router'
import { getRequest } from '@tanstack/react-start/server'
import { getAddress, isAddress } from 'viem'
import { globalSettings } from '../store/repos'
import { runWithTenant } from '../store/tenant'
import { ensureTenantSeeded } from './boot'

if (typeof window !== 'undefined') {
  throw new Error('src/lib/server/session.ts is server-only')
}

export const SESSION_COOKIE = 'tp_session'
export const NONCE_COOKIE = 'tp_nonce'
export const SIWE_CHAIN_ID = 11155111
const SESSION_TTL_S = 7 * 86_400
const NONCE_TTL_S = 300
/** Issued At must be within this window of the server clock. */
const ISSUED_AT_SKEW_MS = 10 * 60_000

export type SessionKind = 'wallet' | 'anon'

export interface Session {
  tenant: string
  kind: SessionKind
  /** Checksummed owner address for wallet sessions. */
  address: string | null
  /** 'demo-abc123' for anonymous sessions, the short address otherwise. */
  label: string
  iat: number
  exp: number
}

/** What the client may see (GET /api/auth/me). */
export interface SessionView {
  tenant: string
  kind: SessionKind
  address: string | null
  label: string
  expiresAt: string
}

let cachedSecret: string | null = null

export function sessionSecret(): string {
  if (cachedSecret) return cachedSecret
  const fromEnv = process.env.SESSION_SECRET?.trim()
  if (fromEnv) {
    cachedSecret = fromEnv
    return fromEnv
  }
  const stored = globalSettings.get('sessionSecret')
  if (stored) {
    cachedSecret = stored
    return stored
  }
  const generated = randomBytes(32).toString('hex')
  globalSettings.set('sessionSecret', generated)
  cachedSecret = generated
  return generated
}

function sign(payload: string): string {
  return createHmac('sha256', sessionSecret()).update(payload).digest('base64url')
}

export function signToken(value: unknown): string {
  const payload = Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
  return `${payload}.${sign(payload)}`
}

export function verifyToken<T>(token: string | null | undefined): T | null {
  if (!token) return null
  const dot = token.lastIndexOf('.')
  if (dot <= 0) return null
  const payload = token.slice(0, dot)
  const sig = Buffer.from(token.slice(dot + 1))
  const expected = Buffer.from(sign(payload))
  if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) return null
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as T
  } catch {
    return null
  }
}

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    const raw = part.slice(eq + 1).trim()
    try {
      out[part.slice(0, eq).trim()] = decodeURIComponent(raw)
    } catch {
      out[part.slice(0, eq).trim()] = raw
    }
  }
  return out
}

export function isSecureRequest(request: Request): boolean {
  const proto = request.headers.get('x-forwarded-proto')
  if (proto) return proto.split(',')[0]?.trim() === 'https'
  return new URL(request.url).protocol === 'https:'
}

export function cookieHeader(name: string, value: string, request: Request, maxAgeSeconds: number): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSeconds}`]
  if (isSecureRequest(request)) parts.push('Secure')
  return parts.join('; ')
}

export function clearCookieHeader(name: string, request: Request): string {
  return cookieHeader(name, '', request, 0)
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

export function shortLabel(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

export function createWalletSession(address: string): Session {
  if (!isAddress(address)) throw new Error('not a valid address')
  const checksummed = getAddress(address)
  const iat = nowSeconds()
  return { tenant: checksummed.toLowerCase(), kind: 'wallet', address: checksummed, label: shortLabel(checksummed), iat, exp: iat + SESSION_TTL_S }
}

export function createAnonymousSession(): Session {
  const id = randomBytes(12).toString('hex')
  const iat = nowSeconds()
  return { tenant: `anon:${id}`, kind: 'anon', address: null, label: `demo-${id.slice(0, 6)}`, iat, exp: iat + SESSION_TTL_S }
}

export function readSession(request: Request): Session | null {
  const token = parseCookies(request.headers.get('cookie'))[SESSION_COOKIE]
  const session = verifyToken<Session>(token)
  if (!session || typeof session.tenant !== 'string' || !session.tenant) return null
  if (typeof session.exp !== 'number' || session.exp <= nowSeconds()) return null
  return session
}

export function sessionCookie(session: Session, request: Request): string {
  return cookieHeader(SESSION_COOKIE, signToken(session), request, Math.max(1, session.exp - nowSeconds()))
}

export function toView(session: Session): SessionView {
  return { tenant: session.tenant, kind: session.kind, address: session.address, label: session.label, expiresAt: new Date(session.exp * 1000).toISOString() }
}

// ── Nonce (SIWE step 1) ──────────────────────────────────────────────────

interface NoncePayload {
  n: string
  exp: number
}

export function issueNonce(request: Request): { nonce: string; cookie: string } {
  const nonce = randomBytes(16).toString('hex')
  const payload: NoncePayload = { n: nonce, exp: nowSeconds() + NONCE_TTL_S }
  return { nonce, cookie: cookieHeader(NONCE_COOKIE, signToken(payload), request, NONCE_TTL_S) }
}

export function readNonce(request: Request): string | null {
  const payload = verifyToken<NoncePayload>(parseCookies(request.headers.get('cookie'))[NONCE_COOKIE])
  if (!payload || payload.exp <= nowSeconds()) return null
  return payload.n
}

// ── SIWE message (EIP-4361) ──────────────────────────────────────────────

export interface SiweFields {
  domain: string
  address: string
  chainId: number
  nonce: string
  issuedAt: string
  expirationTime: string | null
}

/** Parses the EIP-4361 message the client built (src/lib/auth/siwe.ts). Returns null when the shape is off. */
export function parseSiweMessage(message: string): SiweFields | null {
  const lines = message.split('\n')
  const head = /^(.+) wants you to sign in with your Ethereum account:$/.exec(lines[0] ?? '')
  const address = lines[1]?.trim() ?? ''
  if (!head || !isAddress(address)) return null
  const field = (name: string): string | null => {
    const hit = lines.find((l) => l.startsWith(`${name}: `))
    return hit ? hit.slice(name.length + 2).trim() : null
  }
  const chainId = Number(field('Chain ID'))
  const nonce = field('Nonce')
  const issuedAt = field('Issued At')
  if (!Number.isFinite(chainId) || !nonce || !issuedAt) return null
  return { domain: head[1] ?? '', address, chainId, nonce, issuedAt, expirationTime: field('Expiration Time') }
}

export function requestHost(request: Request): string {
  return request.headers.get('x-forwarded-host')?.split(',')[0]?.trim() || request.headers.get('host') || new URL(request.url).host
}

/** Everything but the signature: domain, chain, nonce, time window. Throws a readable error. */
export function checkSiweFields(fields: SiweFields, request: Request): void {
  const host = requestHost(request)
  if (fields.domain !== host) throw new Error(`message domain ${fields.domain} does not match ${host}`)
  if (fields.chainId !== SIWE_CHAIN_ID) throw new Error(`chain id must be ${SIWE_CHAIN_ID} (Sepolia)`)
  const expected = readNonce(request)
  if (!expected) throw new Error('nonce expired; request a new one')
  if (fields.nonce !== expected) throw new Error('nonce mismatch')
  const issued = new Date(fields.issuedAt).getTime()
  if (!Number.isFinite(issued) || Math.abs(Date.now() - issued) > ISSUED_AT_SKEW_MS) throw new Error('message is too old or from the future')
  if (fields.expirationTime) {
    const exp = new Date(fields.expirationTime).getTime()
    if (!Number.isFinite(exp) || exp <= Date.now()) throw new Error('message expired')
  }
}

// ── Tenant resolution for server functions and API routes ────────────────

/** Session of the current server-function request, or null. */
export function currentSession(): Session | null {
  return readSession(getRequest())
}

/** For server functions: the session, or a redirect to the connect page (the client follows it). */
export function requireSession(): Session {
  const session = currentSession()
  if (!session) throw redirect({ to: '/' })
  return session
}

export function requireTenant(): string {
  return requireSession().tenant
}

/** Server-function body: resolve the session, seed the tenant's agents once, run `fn` inside the tenant context. */
export function withSession<T>(fn: (tenant: string, session: Session) => T): T {
  const session = requireSession()
  ensureTenantSeeded(session.tenant)
  return runWithTenant(session.tenant, () => fn(session.tenant, session))
}

/** API-route body: 401 JSON when there is no session, else `fn` inside the tenant context. */
export async function withRequestSession(request: Request, fn: (tenant: string, session: Session) => Response | Promise<Response>): Promise<Response> {
  const session = readSession(request)
  if (!session) return Response.json({ error: 'unauthorized' }, { status: 401, headers: { 'cache-control': 'no-store' } })
  ensureTenantSeeded(session.tenant)
  return runWithTenant(session.tenant, () => fn(session.tenant, session))
}

/** For non-session callers (the Thyme task): run inside a tenant resolved elsewhere, agents seeded. */
export function withTenant<T>(tenant: string, fn: (tenant: string) => T): T {
  ensureTenantSeeded(tenant)
  return runWithTenant(tenant, () => fn(tenant))
}
