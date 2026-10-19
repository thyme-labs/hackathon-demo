import { type CheckContext, type CheckSpec, makeResult } from './context'

const spec = { id: 'invoice_integrity', label: 'Invoice integrity', enforcement: 'agent', weight: 10 } as const

export const INSTRUCTION_LIKE =
  /\b(ignore|disregard|forget|override)\b.{0,40}\b(previous|prior|above|all|earlier|system)\b.{0,40}\b(instruction|rule|polic|prompt|registry)|\b(system (prompt|notice|message)|assistant|ai agent|language model|llm)\b|\bpay (instead|immediately|to the new|this invoice to)\b|\bnew (wallet|address|bank|account)\b|\bupdated (payment )?(wallet|address|details)\b|\burgent(ly)?\b/i

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

export const run = async (ctx: CheckContext) => {
  const inv = ctx.extracted.invoice
  const fails: string[] = []
  const warns: string[] = []
  const notes: string[] = []
  const source = 'invoice store + extractor'
  const today = ctx.now.toISOString().slice(0, 10)

  const sameNumber = ctx.store
    .findInvoicesByNumber(inv.number, ctx.invoice.id)
    .filter((i) => i.status !== 'rejected' && i.status !== 'failed')
  if (sameNumber.length) {
    const sameBeneficiary = sameNumber.some((i) => i.beneficiary_id && i.beneficiary_id === ctx.beneficiary?.id)
    fails.push(`duplicate invoice number ${inv.number} (${sameNumber.length} earlier, ${sameBeneficiary ? 'same payee' : 'other payee'})`)
  }

  if (ctx.beneficiary) {
    const history = ctx.store
      .listInvoicesForBeneficiary(ctx.beneficiary.id, ctx.invoice.id)
      .filter((i) => (i.status === 'paid' || i.status === 'approved' || i.status === 'paying') && i.currency === inv.currency && i.amount)
      .map((i) => i.amount as number)
    const med = median(history)
    if (med && inv.gross > 3 * med) warns.push(`amount ${inv.gross} ${inv.currency} is more than 3x the median of ${history.length} earlier invoices (${med})`)
    else if (med) notes.push(`amount in line with ${history.length} earlier invoices (median ${med} ${inv.currency})`)
    else notes.push('no payment history yet')
  }

  if (inv.issue_date && inv.issue_date > today) warns.push(`issue date ${inv.issue_date} is in the future`)
  if (inv.issue_date && inv.due_date && inv.due_date < inv.issue_date) warns.push(`due date ${inv.due_date} precedes issue date ${inv.issue_date}`)
  if (inv.due_date) {
    const overdueDays = Math.floor((ctx.now.getTime() - new Date(inv.due_date).getTime()) / 86_400_000)
    if (overdueDays > 90) warns.push(`due date ${inv.due_date} is ${overdueDays} days past`)
  }
  if (!inv.due_date) notes.push('no due date printed')

  if (Math.abs(inv.net + inv.vat - inv.gross) > 0.01) warns.push(`net ${inv.net} + VAT ${inv.vat} != gross ${inv.gross}`)
  if (inv.line_items.length) {
    const sum = inv.line_items.reduce((s, l) => s + l.total, 0)
    if (Math.abs(sum - inv.net) > 0.01) warns.push(`line items sum to ${sum.toFixed(2)}, net is ${inv.net}`)
  }
  if (inv.gross <= 0) fails.push('gross amount is zero or negative')

  const texts = [ctx.extracted.notes ?? '', ...ctx.extracted.suspicious_text, ...inv.line_items.map((l) => l.description)]
  const injected = texts.filter((t) => INSTRUCTION_LIKE.test(t))
  if (injected.length) fails.push(`instruction-like text in the document: "${injected[0].slice(0, 140)}"`)
  else if (ctx.extracted.suspicious_text.length) warns.push(`extractor flagged text: "${ctx.extracted.suspicious_text[0].slice(0, 140)}"`)
  if (ctx.extracted.confidence < 0.5) warns.push(`extraction confidence ${ctx.extracted.confidence.toFixed(2)}`)

  const data = { fails, warns, notes, number: inv.number, gross: inv.gross, currency: inv.currency }
  if (fails.length) return makeResult(spec, ctx, { status: 'fail', evidence: `${fails.join('; ')}.`, source, data })
  if (warns.length) return makeResult(spec, ctx, { status: 'warn', evidence: `${warns.join('; ')}.`, source, data })
  return makeResult(spec, ctx, {
    status: 'pass',
    evidence: `No duplicate of ${inv.number}; arithmetic consistent; dates plausible; no instruction-like text${notes.length ? `; ${notes.join('; ')}` : ''}.`,
    source,
    data,
  })
}

export const invoiceIntegrity: CheckSpec = { ...spec, run }
