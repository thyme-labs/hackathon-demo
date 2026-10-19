import { timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { getThymeEnv } from './env'
import type { ThymeCallback } from './types'

/**
 * Wire contract of the two routes the Flow task talks to, kept next to the client so the
 * task (thyme/functions/pay-invoice) and the app agree. The routes themselves currently
 * carry inline copies; these exports are for anyone refactoring them or writing tests.
 *   GET  /api/thyme/pending   -> pendingResponseSchema
 *   POST /api/webhooks/thyme  -> thymeCallbackSchema
 */

export const THYME_TOKEN_HEADER = 'X-Thyme-Token'

export const pendingPayoutSchema = z.object({
  payoutId: z.string().min(1),
  invoiceId: z.string().min(1),
  invoiceNumber: z.string().nullable(),
  beneficiaryId: z.string().nullable(),
  to: z.string().nullable(),
  amountEurc: z.string().regex(/^[0-9]+$/, 'EURC base units as a decimal string'),
  amountEur: z.number(),
  createdAt: z.string(),
})

export const pendingResponseSchema = z.object({
  token: z.literal('EURC'),
  chainId: z.literal(11155111),
  payouts: z.array(pendingPayoutSchema),
})

/** Identical to the Callback schema in src/routes/api/webhooks/thyme.ts. */
export const thymeCallbackSchema = z.object({
  executionId: z.string().min(1),
  invoiceId: z.string().min(1).optional(),
  payoutId: z.string().min(1).optional(),
  txHash: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/)
    .optional()
    .nullable(),
  status: z.enum(['pending', 'submitted', 'confirmed', 'failed', 'reverted']),
  blockNumber: z.number().int().nonnegative().optional().nullable(),
  gasUsed: z.number().int().nonnegative().optional().nullable(),
  error: z.string().optional().nullable(),
})

/**
 * Constant-time check of X-Thyme-Token against THYME_PULL_TOKEN.
 * Same rule as the routes: when the token is empty the endpoints run open (local dev).
 */
export function isAuthorizedThymeRequest(request: Request): boolean {
  const expected = getThymeEnv().pullToken
  if (!expected) return true
  const presented = request.headers.get(THYME_TOKEN_HEADER)
  if (!presented) return false
  const encoder = new TextEncoder()
  const a = encoder.encode(presented)
  const b = encoder.encode(expected)
  return a.byteLength === b.byteLength && timingSafeEqual(a, b)
}

export type ParsedCallback = { ok: true; callback: ThymeCallback } | { ok: false; error: string }

export function parseThymeCallback(body: unknown): ParsedCallback {
  const parsed = thymeCallbackSchema.safeParse(body)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join('.') || '$'}: ${issue.message}`)
    return { ok: false, error: issues.join('; ') }
  }
  return { ok: true, callback: parsed.data as ThymeCallback }
}
