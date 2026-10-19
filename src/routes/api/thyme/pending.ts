import { createFileRoute } from '@tanstack/react-router'

/**
 * GET /api/thyme/pending — work for the Thyme Flow `payroll-run` task.
 * Returns pending payouts (executor=thyme) whose invoice is approved. Secured by X-Thyme-Token when
 * THYME_PULL_TOKEN is set; open in dev when it is empty.
 */
export const Route = createFileRoute('/api/thyme/pending')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { serverEnv } = await import('@/lib/env')
        const expected = serverEnv.thymePullToken()
        const provided = request.headers.get('x-thyme-token') ?? ''
        if (expected && !timingSafeEqual(expected, provided)) {
          return Response.json({ error: 'unauthorized' }, { status: 401 })
        }
        const { payouts } = await import('@/lib/store/repos')
        const rows = payouts.listPendingForThyme()
        return Response.json(
          {
            token: 'EURC',
            chainId: 11155111,
            payouts: rows.map((p) => ({
              payoutId: p.id,
              invoiceId: p.invoice_id,
              invoiceNumber: p.invoice_number,
              beneficiaryId: p.beneficiary_id,
              to: p.payee_wallet,
              amountEurc: p.amount_eurc,
              amountEur: p.amount_eur,
              createdAt: p.created_at,
            })),
          },
          { headers: { 'cache-control': 'no-store' } },
        )
      },
    },
  },
})

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
