import { isKnownDisclaimer } from '../disclaimer'
import { type CheckContext, type CheckSpec, makeResult } from './context'

const spec = { id: 'invoice_integrity', label: 'Invoice integrity', enforcement: 'agent', weight: 10 } as const

export const INSTRUCTION_LIKE =
  /\b(ignore|disregard|forget|override)\b.{0,40}\b(previous|prior|above|all|earlier|system)\b.{0,40}\b(instruction|rule|polic|prompt|registry)|\b(system (prompt|notice|message)|assistant|ai agent|language model|llm)\b|\bpay (instead|immediately|to the new|this invoice to)\b|\bnew (wallet|address|bank|account)\b|\bupdated (payment )?(wallet|address|details)\b|\burgent(ly)?\b|\b(set|change|update|override|adjust|correct)\s+(the\s+)?(amount|total|price|sum|status)\s+to\b|\bmark(ed)?\s+(it\s+|this\s+|the\s+invoice\s+)?as\s+paid\b/i

/**
 * Claims a document makes about its own compliance status. They carry no weight (the score is
 * computed from the checks, never read from the PDF) and are reported so the owner sees the attempt.
 */
export const SELF_ASSERTED_COMPLIANCE =
  /\b(compliance|kyc|aml|sanctions?|screening|due diligence)\b[^.;\n]{0,24}\b(approved|passed|cleared|verified|complete[d]?|ok)\b|\bscore\s*:?\s*\d{1,3}\s*(\/|out of)\s*100\b|\bauto-?pay(ment|out)?\s+(is\s+)?(authori[sz]ed|approved|enabled)\b|\bpre-?approved\b|\b(thyme|agent|auditor|cfo|ceo|compliance)[\s-]+(verified|approved|authori[sz]ed)\b|\bverified by (thyme|the agent|compliance)\b/i

const CYRILLIC_OR_GREEK = /[Ͱ-ϿЀ-ӿ]/
const LATIN = /[A-Za-z]/

// Cyrillic and Greek letters that render like Latin ones in most fonts (Unicode confusables).
const LOOKALIKE_TO_LATIN: Record<string, string> = {
  А: 'A', В: 'B', Е: 'E', К: 'K', М: 'M', Н: 'H', О: 'O', Р: 'P', С: 'C', Т: 'T', Х: 'X', І: 'I', Ј: 'J', Ѕ: 'S',
  а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', у: 'y', х: 'x', і: 'i', ј: 'j', ѕ: 's',
  Α: 'A', Β: 'B', Ε: 'E', Ζ: 'Z', Η: 'H', Ι: 'I', Κ: 'K', Μ: 'M', Ν: 'N', Ο: 'O', Ρ: 'P', Τ: 'T', Υ: 'Y', Χ: 'X', ο: 'o',
}

const codePoint = (ch: string): string => `U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`

/** Folds known Cyrillic/Greek look-alikes to Latin after NFKC, for comparing a printed name with the registry. */
export const foldLookalikes = (name: string): string =>
  [...name.normalize('NFKC')].map((ch) => LOOKALIKE_TO_LATIN[ch] ?? ch).join('')

/**
 * A name that mixes Latin with Cyrillic or Greek letters, or that only equals a registered name after
 * folding look-alike characters, is the spelling trick behind payee-impersonation invoices.
 * Returns a description of the problem, or null for an ordinary name (all-Latin or all-Cyrillic alike).
 */
export const describeLookalikeName = (printed: string, registered: string | null | undefined): string | null => {
  const nfkc = printed.normalize('NFKC')
  const mixed = LATIN.test(nfkc) && CYRILLIC_OR_GREEK.test(nfkc)
  const folded = foldLookalikes(printed)
  const impersonates = !!registered && folded !== nfkc && folded.toLowerCase() === registered.normalize('NFKC').toLowerCase()
  if (!mixed && !impersonates) return null
  const odd = [...nfkc].filter((ch) => CYRILLIC_OR_GREEK.test(ch)).map((ch) => `"${ch}" ${codePoint(ch)}`)
  const script = /[Ѐ-ӿ]/.test(nfkc) ? 'Cyrillic' : 'Greek'
  const base = mixed
    ? `payee name "${printed}" mixes Latin and ${script} letters (${odd.join(', ')})`
    : `payee name "${printed}" contains ${script} look-alike letters (${odd.join(', ')})`
  return impersonates ? `${base}; it reads as the registered name "${registered}" only after folding the look-alikes (impersonation pattern)` : base
}

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
  // Allowlist for exactly our own disclaimer sentence (../disclaimer.ts), applied after
  // INSTRUCTION_LIKE has run over every text. Extractions stored before the extractor
  // started dropping it still carry it in suspicious_text.
  const flagged = ctx.extracted.suspicious_text.filter((t) => !isKnownDisclaimer(t))
  const disclaimers = ctx.extracted.suspicious_text.length - flagged.length
  if (injected.length) fails.push(`instruction-like text in the document: "${injected[0].slice(0, 140)}"`)
  else if (flagged.length) warns.push(`extractor flagged text: "${flagged[0].slice(0, 140)}"`)
  else if (disclaimers) notes.push(`extractor quoted the synthetic-document disclaimer (${disclaimers}); ignored as a known notice`)
  // Self-asserted "approved / score 100 / verified" stamps: the score never reads the PDF, so they change nothing;
  // the attempt itself is what the owner should see.
  const asserted = texts.filter((t) => SELF_ASSERTED_COMPLIANCE.test(t))
  if (asserted.length) warns.push(`self-asserted compliance claim printed on the invoice, ignored for scoring: "${asserted[0].slice(0, 140)}"`)
  const lookalike = describeLookalikeName(ctx.extracted.payee.name, ctx.beneficiary?.name)
  if (lookalike) warns.push(lookalike)
  if (ctx.extracted.confidence < 0.5) warns.push(`extraction confidence ${ctx.extracted.confidence.toFixed(2)}`)

  const data = { fails, warns, notes, number: inv.number, gross: inv.gross, currency: inv.currency, self_asserted: asserted.length, lookalike_name: lookalike !== null }
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
