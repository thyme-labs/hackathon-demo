import { env, serverEnv } from '../env'
import type { PaymentExecutor } from './types'

/** Public default of the thyme CLI (docs: /cli/api-url). Deployments may use another base. */
export const THYME_PUBLIC_API_URL = 'https://flow.thymelabs.io/http'

export interface ThymeEnv {
  /** Management API base, including any path prefix (THYME_API_URL). */
  apiUrl: string
  /** Workspace API key with executions:read (THYME_API_KEY). Optional: webhook-only setups work without it. */
  apiKey?: string
  /** Only for unbound keys: sent as X-Workspace-Id (THYME_WORKSPACE_ID). */
  workspaceId?: string
  /** Run-only webhook URL of the pay-invoice executable (THYME_PAY_WEBHOOK_URL). A credential. */
  webhookUrl?: string
  /** Executable id, for listing executions and the management-run fallback (THYME_EXECUTABLE_ID). */
  executableId?: string
  /** Shared secret the Flow task presents as X-Thyme-Token (THYME_PULL_TOKEN). Empty = routes run open. */
  pullToken?: string
  /** Public origin of this app; the task calls {appUrl}/api/thyme/pending and /api/webhooks/thyme (APP_URL). */
  appUrl: string
  /** PAYMENT_EXECUTOR, read through serverEnv (default direct). */
  paymentExecutor: PaymentExecutor
}

function optional(name: string): string | undefined {
  const value = env(name).trim()
  return value ? value : undefined
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '')
}

export function getThymeEnv(): ThymeEnv {
  return {
    apiUrl: stripTrailingSlash(optional('THYME_API_URL') ?? THYME_PUBLIC_API_URL),
    apiKey: optional('THYME_API_KEY'),
    workspaceId: optional('THYME_WORKSPACE_ID'),
    webhookUrl: optional('THYME_PAY_WEBHOOK_URL'),
    executableId: optional('THYME_EXECUTABLE_ID'),
    pullToken: serverEnv.thymePullToken() || undefined,
    appUrl: stripTrailingSlash(serverEnv.appUrl()),
    paymentExecutor: serverEnv.paymentExecutor() === 'thyme' ? 'thyme' : 'direct',
  }
}

export type ThymeTriggerMode = 'webhook' | 'management-run' | 'none'

/** How triggerPayout will reach Thyme with the current env. */
export function getThymeTriggerMode(current: ThymeEnv = getThymeEnv()): ThymeTriggerMode {
  if (current.webhookUrl) return 'webhook'
  if (current.apiKey && current.executableId) return 'management-run'
  return 'none'
}

/** True when executions can be read back (agents page, reconciliation). */
export function canReadThymeExecutions(current: ThymeEnv = getThymeEnv()): boolean {
  return Boolean(current.apiKey)
}
