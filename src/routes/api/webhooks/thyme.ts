import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'

const Callback = z.object({
  executionId: z.string().min(1),
  invoiceId: z.string().min(1).optional(),
  payoutId: z.string().min(1).optional(),
  txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional().nullable(),
  status: z.enum(['pending', 'submitted', 'confirmed', 'failed', 'reverted']),
  blockNumber: z.number().int().nonnegative().optional().nullable(),
  gasUsed: z.number().int().nonnegative().optional().nullable(),
  error: z.string().optional().nullable(),
})

/** POST /api/webhooks/thyme — execution callback from Thyme Flow. X-Thyme-Token selects the tenant like /api/thyme/pending. */
export const Route = createFileRoute('/api/webhooks/thyme')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { resolveThymeTenant } = await import('@/lib/server/tenantThyme')
        const tenant = resolveThymeTenant(request.headers.get('x-thyme-token') ?? '')
        if (!tenant) return Response.json({ error: 'unauthorized' }, { status: 401 })
        const parsed = Callback.safeParse(await request.json().catch(() => null))
        if (!parsed.success) {
          return Response.json({ error: 'invalid payload', issues: parsed.error.issues }, { status: 400 })
        }
        const body = parsed.data
        const { withTenant } = await import('@/lib/server/session')
        return withTenant(tenant, async () => {
          const { forTenant, nowIso } = await import('@/lib/store/repos')
          const { payouts, invoices, beneficiaries, appendAudit } = forTenant(tenant)
          const { onPayoutCallback } = await import('@/lib/integration')

          const payout =
            (body.payoutId ? payouts.get(body.payoutId) : null) ??
            payouts.byExecutionId(body.executionId) ??
            (body.invoiceId ? (payouts.byInvoice(body.invoiceId)[0] ?? null) : null)
          if (!payout) return Response.json({ error: 'payout not found' }, { status: 404 })

          const ts = nowIso()
          const settled = payout.status === 'confirmed' || payout.status === 'failed' || payout.status === 'reverted'
          if (settled) {
            // Already settled (by an earlier callback or by the payment agent reading Thyme's result):
            // keep the verdict, only fill in transaction details the row is missing. Never pay twice.
            const merged = payouts.update(payout.id, {
              thyme_execution_id: payout.thyme_execution_id ?? body.executionId,
              tx_hash: payout.tx_hash ?? body.txHash ?? null,
              block_number: payout.block_number ?? body.blockNumber ?? null,
              gas_used: payout.gas_used ?? body.gasUsed ?? null,
          })
          appendAudit({ actor: 'thyme', event: 'payout.callback_after_settlement', invoiceId: payout.invoice_id, beneficiaryId: payout.beneficiary_id, details: { payoutId: payout.id, executionId: body.executionId, callback: body.status, kept: payout.status } })
          return Response.json({ ok: true, payout: merged, ignored: true })
        }
        const updated = payouts.setStatus(payout.id, body.status, {
          thyme_execution_id: body.executionId,
          tx_hash: body.txHash ?? payout.tx_hash,
          block_number: body.blockNumber ?? payout.block_number,
          gas_used: body.gasUsed ?? payout.gas_used,
          error: body.error ?? null,
          submitted_at: body.status === 'submitted' || body.status === 'confirmed' ? (payout.submitted_at ?? ts) : payout.submitted_at,
          confirmed_at: body.status === 'confirmed' ? ts : payout.confirmed_at,
        })

        if (body.status === 'confirmed') {
          invoices.setStatus(payout.invoice_id, 'paid')
          if (payout.beneficiary_id) beneficiaries.recordPaid(payout.beneficiary_id, payout.amount_eur, ts)
        } else if (body.status === 'failed' || body.status === 'reverted') {
          invoices.setStatus(payout.invoice_id, 'failed', { decision_text: body.error ?? `Execution ${body.status}` })
        } else if (body.status === 'submitted') {
          invoices.setStatus(payout.invoice_id, 'paying')
        }

        appendAudit({
          actor: 'thyme',
          event: `payout.${body.status}`,
          invoiceId: payout.invoice_id,
          beneficiaryId: payout.beneficiary_id,
          details: { payoutId: payout.id, executionId: body.executionId, txHash: body.txHash ?? null, error: body.error ?? null },
        })
        void onPayoutCallback(payout.id)
        return Response.json({ ok: true, payout: updated })
        })
      },
    },
  },
})
