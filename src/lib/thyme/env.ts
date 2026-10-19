import { env, serverEnv } from '../env'
import type { PaymentExecutor } from './types'

/** Public default of the thyme CLI (docs: /cli/api-url). Deployments may use another base. */
export const THYME_PUBLIC_API_URL = 'https://flow.thymelabs.io/http'

export interface ThymeEnv {
  /** Management API base, including any path prefix (THYME_API_URL). */
  apiUrl: string
  /** Management or project API key (THYME_API_KEY). Required for every /api/v1 call. */
  apiKey?: string
  /** Only for unbound keys: sent as X-Workspace-Id (THYME_WORKSPACE_ID). */
  workspaceId?: string
  /** Thyme project that holds the function, profile and executable (THYME_PROJECT_ID). */
  projectId?: string
  /** Uploaded pay-invoice function release (THYME_FUNCTION_ID, from `thyme upload`). */
  functionId?: string
  /** Shared secret the Flow task presents as X-Thyme-Token (THYME_PULL_TOKEN). Empty = routes run open. */
  pullToken?: string
  /** Public origin of this app; the task calls {appUrl}/api/thyme/pending and /api/webhooks/thyme (APP_URL). */
  appUrl: string
  /** PAYMENT_EXECUTOR: 'thyme' or anything else = 'simulated'. */
  paymentExecutor: PaymentExecutor
  /** Pre-provisioned executable, optional (THYME_EXECUTABLE_ID). The onboarding stores its own in settings. */
  executableId?: string
  /** Pre-provisioned run-only webhook URL, optional (THYME_PAY_WEBHOOK_URL). A credential. */
  webhookUrl?: string
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
    projectId: optional('THYME_PROJECT_ID'),
    functionId: optional('THYME_FUNCTION_ID'),
    pullToken: serverEnv.thymePullToken() || undefined,
    appUrl: stripTrailingSlash(serverEnv.appUrl()),
    paymentExecutor: serverEnv.paymentExecutor() === 'thyme' ? 'thyme' : 'simulated',
    executableId: optional('THYME_EXECUTABLE_ID'),
    webhookUrl: optional('THYME_PAY_WEBHOOK_URL'),
  }
}

/** Ids the onboarding stored in the settings table; they win over the env fallbacks. */
export interface ThymeRuntimeIds {
  executableId?: string | null
  webhookUrl?: string | null
}

/** True when the app can drive the Thyme onboarding (prepare profile, create executable). */
export function canOnboardThyme(current: ThymeEnv = getThymeEnv()): boolean {
  return Boolean(current.apiKey && current.projectId && current.functionId)
}

export type ThymeTriggerMode = 'webhook' | 'management-run' | 'none'

/** How triggerPayout will reach Thyme with the current env plus the stored ids. */
export function getThymeTriggerMode(current: ThymeEnv = getThymeEnv(), stored: ThymeRuntimeIds = {}): ThymeTriggerMode {
  if (stored.webhookUrl || current.webhookUrl) return 'webhook'
  if (current.apiKey && (stored.executableId || current.executableId)) return 'management-run'
  return 'none'
}

/** True when executions can be read back (agents page, reconciliation). */
export function canReadThymeExecutions(current: ThymeEnv = getThymeEnv()): boolean {
  return Boolean(current.apiKey)
}
