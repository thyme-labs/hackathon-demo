// Plain-language descriptions of every compliance check, keyed by CheckId.
// Shown in the checklist info tooltip. Keep each field to three sentences at most
// and consistent with the check implementation in ../checks/* and PLAN.md §3.
import type { CheckId, Enforcement } from '../types'

export interface CheckDescription {
  title: string
  /** What the check does, in one breath. */
  what: string
  /** Which data it reads (lists, registries, APIs, chain). */
  data: string
  /** Who enforces it: Roles conditions on the Safe, or the agent before Thyme is called. */
  enforcement: Enforcement
  whyItMatters: string
}

export const CHECK_DESCRIPTIONS: Record<CheckId, CheckDescription> = {
  known_beneficiary: {
    title: 'Known beneficiary',
    what: 'Looks the payee up in the beneficiary registry by tax id, wallet or name and reads its status.',
    data: 'Beneficiary registry: status (new, active, paused, blocked), total paid to date and trust score.',
    enforcement: 'agent',
    whyItMatters: 'A new, paused or blocked payee needs the owner. Only active beneficiaries are paid without a signature.',
  },
  wallet_matches_file: {
    title: 'Wallet matches file',
    what: 'Compares the wallet printed on the invoice with the wallet stored for the beneficiary.',
    data: 'Wallet extracted from the PDF and the wallet on file in the registry.',
    enforcement: 'agent',
    whyItMatters:
      'Swapped-wallet invoices are the classic payroll fraud. The payment rail only ever sends to the wallet on file, and the Roles allowlist on the Safe rejects any other recipient.',
  },
  sanctions_person_entity: {
    title: 'Sanctions: person / entity',
    what: 'Screens the payee name (person or company) against sanctions lists using exact, token and fuzzy matching.',
    data: 'EU consolidated financial sanctions list, OFAC SDN list and the Czech national list, each with its publication date.',
    enforcement: 'agent',
    whyItMatters: 'A strong hit stops the payment and must be reported to the FAU. A fuzzy near-match goes to a human.',
  },
  sanctions_wallet: {
    title: 'Sanctions: wallet',
    what: 'Checks the wallet on file and the wallet printed on the invoice against sanctioned crypto addresses.',
    data: 'ETH addresses in the OFAC SDN list and address remarks in the EU consolidated list.',
    enforcement: 'agent',
    whyItMatters: 'Paying a listed address is a sanctions breach even when the name looks clean.',
  },
  firm_licence_warnings: {
    title: 'Firm licence & warnings',
    what: 'For companies, looks the payee up by LEI, website domain and name in a dataset of EU financial firm licences and regulator warnings. Skipped for natural persons.',
    data: 'Mostly Right "EU financial firm licences and regulator warnings" dataset; the dataset version is logged with the result.',
    enforcement: 'agent',
    whyItMatters: 'A regulator warning or sanction row stops the payment. No rows is not proof of licensing; a software contractor needs none.',
  },
  country_risk: {
    title: 'Country risk',
    what: 'Maps the payee country to an ISO code and checks it against dated country risk tables.',
    data: 'EU comprehensive sanctions regimes, FATF call for action, EU high-risk third countries and FATF increased monitoring, from config/lists.json.',
    enforcement: 'agent',
    whyItMatters: 'A comprehensively sanctioned country blocks the payout. Grey-list countries need enhanced due diligence and owner review.',
  },
  public_footprint: {
    title: 'Public footprint',
    what: 'Runs a web search on the payee name, country and website, then has the reasoning model summarise whether the results fit the record. Skipped without an Apify token; the mock provider answers from the demo corpus.',
    data: 'Apify Google Search results, treated as untrusted input, summarised by the model; the model id is logged.',
    enforcement: 'agent',
    whyItMatters: 'No footprint, the wrong country or public fraud reports deserve a second look. This is an AI-generated signal, not a verdict.',
  },
  invoice_integrity: {
    title: 'Invoice integrity',
    what: 'Deterministic checks on the extracted invoice: duplicate number, amount against the payee history, date sanity, net + VAT = gross, line item sums and instruction-like text in the PDF.',
    data: 'The invoice store and the fields extracted from the PDF, including text the extractor flagged as suspicious.',
    enforcement: 'agent',
    whyItMatters: 'Duplicates and prompt-injection text stop the payment. Arithmetic or date oddities ask for a human look.',
  },
  fx_rate: {
    title: 'FX rate',
    what: 'Converts the invoice amount to EUR, and so to EURC, with a mid rate and records the CNB fixing of the day for the accounting leg.',
    data: 'Tatum rate API, Frankfurter (ECB) as fallback and a static table as last resort; CNB daily fixing.',
    enforcement: 'agent',
    whyItMatters: 'The EUR amount feeds the budget check and the remittance advice. A dated static rate is flagged for owner review.',
  },
  issuer_backing: {
    title: 'Issuer backing (MiCA EMT)',
    what: 'Confirms the EURC issuer is in the ESMA e-money token register and compares the latest reserve attestation with live on-chain supply.',
    data: 'ESMA EMT register row for Circle, the reserve attestation in config/issuers.json, and EURC supply on Ethereum, Base, Avalanche and Solana read via Tatum or public RPC.',
    enforcement: 'agent',
    whyItMatters: 'Backing below 1:1 pauses payouts. A stale attestation or a partial supply read warns for owner review.',
  },
  budget: {
    title: 'Within monthly limit',
    what: 'Adds the pending and confirmed payouts of the last 30 days and tests whether this amount fits the beneficiary monthly limit and, when readable, the live Roles allowance on the Safe.',
    data: 'Beneficiary limit and the payout ledger; the on-chain allowance from the Roles modifier (allowances(key)).',
    enforcement: 'agent',
    whyItMatters:
      'The agent checks before calling Thyme, and the Roles allowance enforces the same cap on chain: a transfer over the limit reverts even if the agent is fooled.',
  },
  ownership_proof: {
    title: 'Wallet ownership proof',
    what: 'Verifies the EIP-712 signature the contractor gave at onboarding to prove control of the wallet on file, and checks its age.',
    data: 'The signature stored on the beneficiary, verified with viem (EIP-1271 aware for smart wallets).',
    enforcement: 'agent',
    whyItMatters:
      'Travel Rule evidence that the payee controls the receiving wallet, needed for off-ramps above €1,000. A missing proof warns (or is skipped for an owner-approved wallet); an invalid one stops the payment.',
  },
  eurc_blacklist: {
    title: 'EURC issuer blacklist',
    what: 'Asks the EURC contract on Sepolia whether the wallet on file, the wallet printed on the invoice and the paying Safe are blacklisted, whether the token is paused, and whether the issuer admin roles still match the stored snapshot.',
    data: 'Circle EURC Sepolia 0x0821…94D4: isBlacklisted, paused, blacklister, owner and masterMinter in one multicall via public RPC; admin snapshot in config/issuers.json.',
    enforcement: 'agent',
    whyItMatters: 'A Circle freeze or pause makes the transfer revert with "Blacklistable: account is blacklisted" after Thyme has already been asked. Reading it first stops the payment with the exact reason; an unreachable RPC is a neutral skip.',
  },
  safe_roles_health: {
    title: 'Safe & Roles rail',
    what: 'Confirms the Roles module is still enabled on the company Safe and points at it, then compares the Safe EURC balance with this payout plus every pending or submitted payout.',
    data: 'Safe isModuleEnabled, Roles avatar/target and EURC balanceOf on Sepolia via public RPC; the payout ledger for open rows.',
    enforcement: 'chain',
    whyItMatters: 'The owner kill switch disables the module; the agent then names the revoked module instead of letting Thyme revert with NotAuthorized. A short balance is held before the rail is asked. Skipped on the simulated rail and on RPC failure.',
  },
  transfer_preflight: {
    title: 'Transfer dry-run',
    what: 'Simulates the exact EURC.transfer from the Safe to the registry wallet, and, when the role key is stored, the Roles execTransactionWithRole call Thyme executor would make.',
    data: 'eth_call and estimateGas on Sepolia via public RPC; Roles v2.1.1 reverts decoded (NoMembership, ConditionViolation, Error(string)).',
    enforcement: 'chain',
    whyItMatters: 'The same transaction Thyme will send, run read-only seconds before: a blacklist or Roles refusal stops the payment, a short balance warns. Medium tier by design: an RPC outage must not hold a payroll, so it skips rather than warns.',
  },
  payee_detail_change: {
    title: 'Payee details stable',
    what: 'Reads the audit log of the payee: wallet changes between registration, updates and activation, monthly limit raises above 2x within 7 days, and a cooling cap on the first payout within 24 hours of registration (min of EUR 500 and 50 % of the limit).',
    data: 'audit_log events beneficiary.registered / updated / activated and owner.wallet_primary_set (wallet, monthly_limit_eur), owner.override, the payout ledger; mirrored to the hash-chained JSONL.',
    enforcement: 'agent',
    whyItMatters: 'Change-of-bank-details fraud pays out on the first transfer after a detail change. A recent wallet change, a sudden limit raise or a large first payout is held for the owner; a plain registration is the baseline, not a change.',
  },
  pep_screening: {
    title: 'PEP screening',
    what: 'For natural persons, looks the payee name up on Wikidata (humans with a public office, end dates of each position, citizenship) and in the OpenSanctions oligarch table. A position still held or ended within 12 months warns; older offices pass with the date. Companies are skipped.',
    data: 'Wikidata SPARQL (P39 position held, P582 end date, P27 citizenship; 8 s timeout) and OpenSanctions wd_oligarchs source table cached 24 h under data/lists. No date of birth is stored, so every hit is a same-name match only.',
    enforcement: 'agent',
    whyItMatters: 'A current or recent PEP needs enhanced due diligence (AMLD5 Art. 22, §4(5) Act 253/2008 Sb.) and never auto-pays. A timeout is a neutral skip, never a hold, so a Wikidata outage cannot block payroll.',
  },
  pdf_forensics: {
    title: 'PDF forensics',
    what: 'Scans the PDF objects and page content streams without a model: text drawn in white, below 4.5 pt or with an invisible render mode, JavaScript/OpenAction/Launch entries, incremental updates (%%EOF count) and a second wallet address in the text layer.',
    data: 'The uploaded file parsed with pdf-lib: fonts and encodings, fill colour, font size and render mode per text operation, dictionary keys of every object, raw %%EOF markers. Glyph strings of embedded font subsets are counted but not read.',
    enforcement: 'agent',
    whyItMatters: 'Hidden text that addresses the agent, names a wallet or an amount is a prompt-injection payload found deterministically, before any model reads the page; the document is rejected. Active content and two printed wallets ask for a human look.',
  },
  payment_pattern: {
    title: 'Payment pattern',
    what: 'Counts payouts to this payee in the 24-hour and 7-day windows around its billing day (printed issue date, confirmed by the payout ledger) and adds up sub-EUR 1,000 invoices of the week: 3 or more that together pass EUR 1,000 is splitting.',
    data: 'Payout ledger (pending, submitted, confirmed) and the invoice store, 7-day window; thresholds calibrated on the ČNB synthetic AML dataset 2Q2026 (3+ payouts in 24 h to one payee: 1 in 100,000 pairs; 4+ in 7 days: none).',
    enforcement: 'agent',
    whyItMatters: 'Structuring below the self-hosted wallet threshold and bursts of payouts to one payee are the AML patterns a bank would flag. Monthly payroll never trips it; a payee splitting one bill into three does, even inside the limit.',
  },
  travel_rule_readiness: {
    title: 'Travel Rule record',
    what: 'Checks whether the originator record (config/originator.json) and the payee record (name, country, address from the invoice, wallet, ownership proof) are complete against the EUR 1,000 self-hosted wallet threshold of the Transfer of Funds Regulation.',
    data: 'Reg. (EU) 2023/1113 Art. 14(5) and 16(2), config/originator.json, the beneficiary registry, the extracted payee address and the EIP-712 ownership proof on file.',
    enforcement: 'agent',
    whyItMatters: "Above EUR 1,000 the payee's exchange must verify the self-hosted wallet and will ask for these records; an incomplete record means a bounced or frozen deposit. The company is the originator, not a CASP: this is readiness, not an obligation.",
  },
}

/** Description for a check id, or null for ids the UI does not know (older checklists). */
export const describeCheck = (id: string): CheckDescription | null =>
  Object.hasOwn(CHECK_DESCRIPTIONS, id) ? CHECK_DESCRIPTIONS[id as CheckId] : null
