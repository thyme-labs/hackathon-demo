import { createFileRoute } from '@tanstack/react-router'

/**
 * GET /api/thyme/pending — work for the Thyme Flow `pay-invoice` task.
 * Returns pending payouts (executor=thyme) whose invoice is approved, oldest first, as
 * { payoutId, invoiceId, wallet, amountEurc } rows (amountEurc = EURC base units, 6 dp, decimal
 * string). `wallet` is always an APPROVED wallet of the beneficiary: the wallet printed on the invoice
 * when the owner approved it, else the primary wallet on file; a pending wallet is never returned.
 * Rows without an approved wallet are left out. X-Thyme-Token selects the tenant: each tenant's pull token
 * (settings.thymePullToken, handed to its executable at onboarding) or the env THYME_PULL_TOKEN for the founder.
 */
export const Route = createFileRoute('/api/thyme/pending')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { resolveThymeTenant } = await import('@/lib/server/tenantThyme')
        const tenant = resolveThymeTenant(request.headers.get('x-thyme-token') ?? '')
        if (!tenant) return Response.json({ error: 'unauthorized' }, { status: 401 })
        const { withTenant } = await import('@/lib/server/session')
        const { forTenant } = await import('@/lib/store/repos')
        const rows = withTenant(tenant, () => forTenant(tenant).payouts.listPendingForThyme())
        return Response.json(
          {
            token: 'EURC',
            chainId: 11155111,
            payouts: rows
              .filter((p) => Boolean(p.payee_wallet))
              .map((p) => ({
                payoutId: p.id,
                invoiceId: p.invoice_id,
                wallet: p.payee_wallet,
                amountEurc: p.amount_eurc,
              })),
          },
          { headers: { 'cache-control': 'no-store' } },
        )
      },
    },
  },
})
