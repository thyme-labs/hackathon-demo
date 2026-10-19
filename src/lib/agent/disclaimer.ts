// Our own synthetic-document notice. demo/make-invoices.ts writes it into the PDF Creator
// metadata (older demo PDFs printed it in the page footer), and a model occasionally quotes
// it as "text addressing a system". The pattern is anchored at both ends: only the bare
// sentence matches, so anything wrapped around it is still screened as suspicious text.
export const KNOWN_DISCLAIMER =
  /^\s*synthetic test document\s*[-–—:]?\s*no real person, company, tax id or bank account\.?\s*(thyme payroll demo(, fintechers hackathon \d{4})?\.?)?\s*$/i

export const isKnownDisclaimer = (text: string): boolean => KNOWN_DISCLAIMER.test(text)
