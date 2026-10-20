import { createServerFn } from '@tanstack/react-start'
import { tenantMiddleware } from './tenantMiddleware'
import type { ReportsView } from './dto'

export const remittanceHtml = createServerFn({ method: 'GET' }).middleware([tenantMiddleware])
  .validator((input: { payoutId: string }) => input)
  .handler(async ({ data }): Promise<string> => {
    const { buildRemittance } = await import('./reports')
    return buildRemittance(data.payoutId)
  })

export const ledgerCsv = createServerFn({ method: 'GET' }).middleware([tenantMiddleware])
  .validator((input: { month?: string | null }) => input)
  .handler(async ({ data }): Promise<string> => {
    const { buildLedgerCsv } = await import('./reports')
    return buildLedgerCsv(data.month ?? null)
  })

export const auditJsonl = createServerFn({ method: 'GET' }).middleware([tenantMiddleware]).handler(async (): Promise<string> => {
  const { buildAuditJsonl } = await import('./reports')
  return buildAuditJsonl()
})

export const getReports = createServerFn({ method: 'GET' }).middleware([tenantMiddleware])
  .validator((input: { month?: string | null }) => input)
  .handler(async ({ data }): Promise<ReportsView> => {
    const { buildReportsView } = await import('./reports')
    return buildReportsView(data.month ?? null)
  })
