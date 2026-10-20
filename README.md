# Thyme Payroll

Pay international contractors in EURC, with an AI agent that checks every invoice and a chain that only lets it pay the right people.

Built at [The FinTechers Hackathon 2026](https://thefintechers.notion.site/hackers-guide_-The-FinTechers-Hackathon-2026-3f41e819981381cf9981d4d0e6f62eba), Track 2: Stablecoins and new financial infrastructure, challenge "The EUR stablecoin payroll rail". Network: Ethereum Sepolia, testnet only. Live demo: https://web-production-e14ca.up.railway.app

## What it does

1. Invoices (PDF, any currency) land in a queue.
2. A compliance agent on Amazon Bedrock takes them one by one: extracts the payee, wallet and amount, then runs a checklist: known beneficiary, wallet matches the one on file, EU/OFAC/CZ sanctions (names and wallet addresses), firm licences and regulator warnings (Mostly Right dataset), country risk, public footprint, invoice integrity (duplicates, anomalies, instruction-like text in the PDF), FX rate to EUR, EURC issuer and reserve backing, budget, wallet-ownership proof. Every check is labelled `chain` or `agent`.
3. A new beneficiary needs one owner approval with a monthly limit. Everything else is automatic.
4. When the checklist is green, the agent triggers Thyme Flow through a webhook. Thyme sends the EURC from the company's own Safe through a Zodiac Roles permission that allows only `EURC.transfer`. The app never holds a key.
5. Every payout gets a remittance advice (EURC, EUR, ČNB rate and CZK, tx hash), a monthly ledger CSV and an audit log, plus a cost/speed comparison with SWIFT and SEPA.

A forged invoice (same payee, different wallet) is stopped by the agent; if the agent were fooled, the chain rejects the transfer anyway.

## Built during the hackathon

This repository was created at kickoff. The starting point is the `hackathon-start` tag; everything after it was built during the event, 19–20 October 2026:

- The whole app: TanStack Start UI (dashboard, invoice queue with live investigation log and severity-sorted checklist, beneficiaries with trust scores, totals and multiple approved wallets, agents, payouts, reports, settings with an editable auto-pay threshold, onboarding), server functions and API routes, SQLite store.
- Approval flows: Approve (register only) vs Approve & send, hold/release, and a double-confirmation "Send anyway" override for stopped invoices that is written to the audit log; Retry on every onboarding step and payout.
- The compliance agent: Bedrock Converse pipeline (Haiku 4.5 extraction with a forced tool, Sonnet 4.5 explanations), 20 deterministic checks (sanctions lists, OFAC wallet addresses, firm licences, country risk, PEP via Wikidata, invoice integrity and PDF forensics, FX via Tatum/ECB with the ČNB rate, EURC issuer backing and Circle blacklist state, Safe/Roles health, a transfer pre-flight simulation, payment patterns, Travel Rule readiness, budgets), a tiered scoring model with hard caps for critical failures, and the auto-pay rules.
- Thyme onboarding over the API: the app asks Thyme to prepare a Roles profile for the user's existing Safe, prompts the owner to sign one transaction in MetaMask, confirms it, creates the executable and its webhook. The user never opens the Thyme console.
- The Thyme Flow task `thyme/functions/pay-invoice` and the webhook callbacks.
- Reports: remittance advice, ledger CSV/JSON, audit JSONL, the SWIFT/SEPA comparison with sourced assumptions (`config/rails.json`).
- Synthetic demo data (`demo/`): five fictional contractors and 27 invoice scenarios in EUR/USD/GBP/INR, including forged wallets, prompt injections, duplicates, structuring, sanctions hits, homoglyph names and a new wallet on a known payee (`demo/README.md`).
- `src/lib/roles`: viem encoders for per-beneficiary Zodiac Roles allowances, verified on a Sepolia fork (`scripts/fork-test.ts`).
- `PLAN.md`.

In the Thyme product itself (closed source, disclosed to the organisers) we added during the hackathon the management API endpoints the onboarding uses: `POST /api/v1/profiles` with `kind: safe_roles` and `POST /api/v1/profiles/{id}/setup`.

## Pre-existing work and credits

- **Thyme** (thymelabs.io) is our existing, closed-source on-chain automation product. We disclosed it to the organisers. None of its code is included here; this app talks to Thyme only through its public HTTP API and webhooks.
- Open source we build on: [Safe](https://github.com/safe-global/safe-smart-account), [Zodiac Roles Modifier](https://github.com/gnosisguild/zodiac-modifier-roles), [viem](https://viem.sh), [wagmi](https://wagmi.sh), [ConnectKit](https://docs.family.co/connectkit), [TanStack](https://tanstack.com), [shadcn/ui](https://ui.shadcn.com), [pdf-lib](https://pdf-lib.js.org).
- Data: EU consolidated sanctions list, OFAC SDN, ESMA interim MiCA registers, ČNB exchange rates, Chainlink feeds, the Mostly Right "EU financial firm licences and regulator warnings" dataset, Circle testnet EURC.
- Models: Anthropic Claude (Haiku 4.5, Sonnet 4.5) on Amazon Bedrock, eu-central-1.
- AI coding assistants (Claude Code, Codex) were used throughout the build.

## Status and to-do

Working on production (Sepolia, Thyme dev): onboarding of a user-owned Safe over the Thyme API, real Bedrock extraction (Haiku 4.5) and explanations (Sonnet 4.5), 20 checks, EURC payouts executed by Thyme Flow with sponsored gas, remittance advice, ledger, audit log, the SWIFT/SEPA comparison, 27 demo scenarios (`demo/README.md`).

Not finished yet:

- [ ] Per-beneficiary monthly limits are enforced by the agent. Putting them on chain as Zodiac Roles allowances on Thyme's Roles proxy (encoders are ready in `src/lib/roles`, fork-tested) needs a Thyme scope-update endpoint. Out of scope for the hackathon; planned as the next Thyme release.
- [ ] Thyme webhook with custom args: the uploaded `pay-invoice` release has no extracted arguments schema, so the app triggers the executable with its saved args and the cron run picks up the oldest pending payout; a v2 upload with an inline `defineTask` schema would let the webhook name the invoice.
- [ ] Public-footprint check (Apify) and firm-licence check (Mostly Right) run only when their keys are configured; otherwise they warn/skip and the invoice waits for approval.
- [ ] PEP screening uses Wikidata and the OpenSanctions oligarch list only; no commercial PEP data.
- [ ] Adverse-media search, VIES VAT-id validation, wallet age/counterparty checks (Blockscout) are specified in the roadmap but not implemented.
- [ ] Multi-owner Safes (threshold > 1) are out of scope: onboarding needs a 1/1 Safe whose owner signs in MetaMask.
- [ ] The Safe{Wallet} connector works when the app runs as a Safe App; over WalletConnect the domain must be allow-listed in the Reown project.
- [ ] Demo data reset and the audit log are unauthenticated on the demo URL (single-tenant demo; add auth before any real use).
- [ ] The agent key custody for Thyme is Thyme's; the app holds no keys. Bedrock credentials on Railway are temporary SSO credentials and expire daily.

## Jury demo

"Jury demo" on the connect page opens an anonymous demo workspace seeded with the five demo contractors, three
historical (labelled simulated) payouts, INV-0388 waiting for approval and the forged INV-0432 stopped, and starts a
guided walkthrough of every screen (the sparkle button in the rail restarts it). The seeded investigations are replayed
from `demo/fixtures/*.json`, recorded once with the mock provider (`scripts/dump-demo-fixtures.ts`), so seeding never
calls a model; everything the judges do afterwards (upload, approve, send anyway) runs the real pipeline. The tour only
appears for tenants with `settings.demoMode = '1'`; wallet sessions never see it and demo tenants always pay through
the labelled simulation.

## Run it

```bash
bun install
cp .env.example .env     # LLM_PROVIDER=mock and PAYMENT_EXECUTOR=simulated work without any keys
bun run dev              # http://localhost:3000
```

See `.env.example` for the Thyme, Bedrock, Tatum and Apify variables. `thyme/README.md` covers the Flow task.

## Safe{Wallet} Safe App

The app is packaged as a Safe App: `public/manifest.json` (served with `Access-Control-Allow-Origin: *`) and a
`Content-Security-Policy: frame-ancestors 'self' https://app.safe.global https://*.safe.global` header on every
response (`routeRules` in `vite.config.ts`; no `X-Frame-Options`). In Safe{Wallet} go to Apps, "My custom apps",
"Add custom Safe App" and paste:

```
https://web-production-e14ca.up.railway.app
```

Inside the iframe the wagmi `safe` connector connects on its own (`src/lib/wallet/safeApp.ts`): the connected
account is the Safe, so step 2 of the onboarding is pre-filled from it and the owner-membership check does not
apply. Step 3 unwraps Thyme's prepared `Safe.execTransaction` and queues the inner call as a Safe transaction
when it is a plain CALL; the usual setup is a MultiSend batch (delegatecall), which a Safe App cannot send, so
the page says to run the one-time setup from the owner's MetaMask instead. MetaMask and WalletConnect are unchanged.
