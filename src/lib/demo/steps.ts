// The jury walkthrough. Every step points at an element carrying data-tour="<target>" on one page; the Tour
// component navigates there, spotlights the element and shows the card. Steps without a target are centred.

export type TourRoute = '/dashboard' | '/invoices' | '/beneficiaries' | '/payouts' | '/reports' | '/settings' | '/onboarding'

export interface TourStep {
  id: string
  route: TourRoute
  /** Seeded invoice to select on /invoices (resolved to ?id= from the demo state). */
  invoice?: 'INV-0388' | 'INV-0432'
  /** data-tour value of the element to spotlight; none = centred card. */
  target?: string
  /** data-tour value of an element to click once when the step opens (a modal or a sheet). */
  clickOnEnter?: string
  /** Close any open modal / sheet (Escape) when leaving the step. */
  dismissOnLeave?: boolean
  /** When the target is a link, offer it as an "Open" action on the card. */
  openLink?: boolean
  title: string
  text: string
}

export const TOUR_STEPS: TourStep[] = [
  {
    id: 'dashboard-total',
    route: '/dashboard',
    target: 'dashboard-total',
    title: 'What the company sees',
    text: 'Invoices waiting, EURC paid, who is registered and which agents are running. The treasury stays in the company Safe.',
  },
  {
    id: 'dashboard-agents',
    route: '/dashboard',
    target: 'dashboard-agents',
    title: 'Two agents, two kinds of rule',
    text: 'The compliance agent checks every invoice; the payment agent hands clean payouts to Thyme Flow. Lock = enforced on chain, sparkle = checked by the agent.',
  },
  {
    id: 'dashboard-activity',
    route: '/dashboard',
    target: 'dashboard-activity',
    title: 'Every decision in one feed',
    text: 'Paid, held, stopped: each line links to the full investigation. Simulated payouts carry a labelled hash.',
  },
  {
    id: 'invoices-queue',
    route: '/invoices',
    invoice: 'INV-0388',
    target: 'invoices-queue',
    title: 'The invoice queue',
    text: 'PDFs land here and are investigated one by one. Upload a new one any time: the real pipeline runs live.',
  },
  {
    id: 'decision-card',
    route: '/invoices',
    invoice: 'INV-0388',
    target: 'decision-card',
    title: 'Extraction and decision',
    text: 'The model reads the PDF; the score ring and one sentence say what the agent concluded and why. INV-0388 is a GBP invoice from a known UK company.',
  },
  {
    id: 'checks-list',
    route: '/invoices',
    invoice: 'INV-0388',
    target: 'checks-list',
    title: '20 checks, sorted by severity',
    text: 'Sanctions, wallet on file, country risk, issuer backing, PDF forensics, budget. Failures first, then warnings. Lock = the chain enforces it, sparkle = the agent does.',
  },
  {
    id: 'approve-buttons',
    route: '/invoices',
    invoice: 'INV-0388',
    target: 'approve-buttons',
    title: 'Approve vs Approve & send',
    text: 'Approve registers the decision and keeps the payout on hold; Approve & send queues the EURC transfer now. Either way the wallet paid is the one on file.',
  },
  {
    id: 'fraud-card',
    route: '/invoices',
    invoice: 'INV-0432',
    target: 'decision-card',
    title: 'A forged invoice',
    text: "INV-0432 carries Anna's name and tax id with a different wallet. Wallet-on-file mismatch caps the score at 10 and nothing moves.",
  },
  {
    id: 'send-anyway',
    route: '/invoices',
    invoice: 'INV-0432',
    clickOnEnter: 'send-anyway',
    target: 'override-dialog',
    dismissOnLeave: true,
    title: 'Overriding is deliberate',
    text: 'The owner must acknowledge every failed check and write a reason; the override is audited. Even then the money goes to the wallet on file, never the one on the PDF. We will not confirm it here.',
  },
  {
    id: 'beneficiaries-table',
    route: '/beneficiaries',
    target: 'beneficiaries-table',
    title: 'Beneficiaries',
    text: 'Trust score, monthly limit, paid this month and in total. A new contractor needs one owner approval; after that clean invoices pay themselves.',
  },
  {
    id: 'beneficiary-wallets',
    route: '/beneficiaries',
    clickOnEnter: 'beneficiary-row',
    target: 'beneficiary-wallets',
    dismissOnLeave: true,
    title: 'Several wallets, only approved ones paid',
    text: 'Anna has two approved wallets and one pending: the address printed on the forged invoice. Pending wallets are never paid until the owner approves them.',
  },
  {
    id: 'payouts-table',
    route: '/payouts',
    target: 'payouts-table',
    title: 'Payouts',
    text: 'Every EURC transfer with its FX leg, the ČNB rate for the CZK books, the executor and the transaction hash.',
  },
  {
    id: 'remittance',
    route: '/payouts',
    target: 'remittance',
    openLink: true,
    title: 'Remittance advice',
    text: 'One document per payout: invoice, EURC amount, EUR and CZK legs, the checks that passed and the transaction. Open one.',
  },
  {
    id: 'reports-comparison',
    route: '/reports',
    target: 'reports-comparison',
    title: 'Versus SWIFT',
    text: 'Fees and business days saved against the realistic rail for each corridor, with every assumption dated and linked in the sources drawer.',
  },
  {
    id: 'settings-autopay',
    route: '/settings',
    target: 'settings-autopay',
    title: 'Auto-pay threshold',
    text: 'The score an invoice needs to be paid without a click. Below it, or with auto-pay off, the owner decides.',
  },
  {
    id: 'onboarding',
    route: '/onboarding',
    target: 'onboarding-steps',
    title: 'Where a real Safe is connected',
    text: 'The owner connects, picks the Safe, and Thyme installs a Roles permission with one signature: EURC.transfer only, from this Safe only. This demo runs the labelled simulation.',
  },
  {
    id: 'closing',
    route: '/dashboard',
    title: 'The LLM never holds a key; the chain enforces the limits.',
    text: 'Thyme Payroll: invoices in, compliance checks, EURC out of the company Safe, with the accounting done. Upload an invoice to try it live.',
  },
]
