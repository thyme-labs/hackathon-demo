# Plan: Thyme Payroll

EUR stablecoin payroll rail (Track 2). Invoice → compliance checks → EURC payout on Ethereum Sepolia → accounting artefacts, with a cost/speed comparison against SEPA/SWIFT.

Code freeze: Tue 20 Oct 2026, 13:30 CEST. Pitch: 4 min demo + 3 min Q&A. This is a demo: one happy path that works every time beats five half-features.

## 1. Product in one paragraph

A company's Safe holds EURC. The owner connects a wallet and uploads an invoice. An AI agent extracts the payee, wallet and amount, screens them, and asks the owner to register the payee once with a monthly limit. That single Safe transaction installs an on-chain permission (Zodiac Roles) that lets the agent key pay **only that payee, only in EURC, only up to the limit**. Every later invoice from a registered payee is checked and paid without the owner, in under a minute. Anything outside the permission reverts on chain, even if the agent is fooled by a forged invoice.

Thyme's role: Thyme Flow is the scheduler and execution runtime, reached only through its public API and webhooks. The Safe + Roles architecture is what Thyme runs in production. No Thyme source code is in this repo.

## 2. Demo script (4 minutes)

| t | Screen | What happens |
|---|---|---|
| 0:00 | Connect | "Thyme exists, this is new." Connect MetaMask (Safe owner). Dashboard: Safe, EURC balance, beneficiaries, agents. |
| 0:30 | Invoice #1 | Upload `INV-0412` from Anna K. (Ukraine). Extraction card; checks run live: sanctions, wallet ownership, country risk, duplicate, issuer (Circle EU, ESMA EMT register). |
| 1:15 | New beneficiary | Card: name, wallet, suggested limit €1 500/mo. Owner edits, signs **one** Safe tx (installs Roles + limit). Payout sent. Tx hash, ~15 s. |
| 2:00 | Invoice #2 | Upload `INV-0431` from Anna K. No signature. Paid automatically. Timer: seconds from upload to block. |
| 2:30 | Fraud | Upload `INV-0432`: Anna's name, a different wallet. Agent flags the mismatch and stops. "Force" (what a fooled agent would do) → chain reverts `ConditionViolation`. Etherscan shows the failed tx. No money moved. |
| 3:15 | Reports | Remittance advice (invoice no, EURC, tx, ČNB rate, CZK), monthly CSV, audit log. Comparison card: "this month: €X and Y business days saved vs SWIFT", with a sources drawer. |
| 3:45 | Kill switch | Owner pauses the agent: one tx, membership revoked. |

## 3. Architecture

```
Railway service "web"  (TanStack Start: React 19 SSR, file routes, server functions, API routes)
  ├─ UI          Tailwind 4 + shadcn/ui. Pages: /connect, /dashboard, /invoices (chat-like flow),
  │              /beneficiaries, /agents, /payouts, /reports, /settings
  ├─ server fns  invoices.process, beneficiaries.register, payouts.execute, reports.*
  ├─ API routes  POST /api/webhooks/thyme   (execution callbacks)   GET /api/thyme/pending (Flow task pulls work)
  │              POST /api/invoices/upload  (PDF)                   GET /api/health
  ├─ lib/agent   LLM provider abstraction: Bedrock (preferred) | Anthropic API | Mock
  │              extract_invoice (Haiku 4.5, forced tool, temperature 0, PDF document block)
  │              validate (deterministic: registry, duplicates, injection text, anomalies)
  │              screen_person / screen_entity / screen_wallet (EU list, OFAC SDN, Mostly Right)
  │              check_issuer (ESMA EMT register row), read_allowance (Roles accrual), explain (Sonnet 4.5)
  ├─ lib/roles   viem encoders from the fork-tested scripts: install, add/remove payee, revoke, decode reverts
  ├─ lib/chain   Safe discovery (tx service), Safe execTransaction (prevalidated sig), balances (multicall)
  ├─ lib/reports remittance advice (HTML→PDF), ledger CSV/JSON, audit JSONL, ČNB FX, rails comparison
  └─ store       SQLite (bun:sqlite) on a Railway volume: beneficiaries, invoices, payouts, agents, audit
Agent signer: EOA, key in Railway variables (testnet only). Stretch: AWS KMS secp256k1.
Thyme Flow: function `payroll-run` (webhook-triggered + cron). Pulls approved payouts from our API,
  returns the EURC.transfer call, executes through a Thyme Roles profile on the same Safe with Lift gas.
  Our backend triggers it via the executable webhook URL and reads results via the executions API.
  Stretch: apply the same per-payee conditions to Thyme's Roles proxy so Thyme itself is capped.
Chain: Ethereum Sepolia. Safe 1.4.1, Zodiac Roles v2.1.1, Circle EURC 0x0821…94D4 (6 dp).
RPC: public (publicnode/drpc) via env. Never a private node URL in the repo.
```

### Why these choices

- **TanStack Start on Railway**: one service, SSR UI + server functions + webhook routes, deployable with `railway up` and a Bun Dockerfile. The team already ships this stack.
- **LLM access**: the AWS team account blocks access keys, so Railway cannot call Bedrock directly. Preferred: a tiny Bedrock proxy Lambda (IAM role, Function URL, shared secret). Fallback: Anthropic API key. Both behind one provider interface; the UI shows which model served a call and the cost.
- **Own Roles module first, Thyme path second**: the per-payee design is fork-tested and gives the "chain enforces" story. Thyme Flow adds scheduling, sponsored gas and execution logs without touching Thyme internals.

### On-chain permission (fork-tested, 48 cases)

- Condition tree: root `Or` → one `Calldata Matches` branch per payee → `to EqualTo payee_i` and `amount WithinAllowance(key_i)`.
- Install for the first payee: 1 owner tx, ~577k gas. Add payee: 1 tx, ~320k, other limits untouched. Payout: ~140k gas.
- Reverts: over limit, unknown payee, `approve`, other token, delegatecall, after revoke. With the `Or` root the revert is `OrViolation`, so the agent explains the reason itself before sending.
- Allowance = per-payee monthly cap, 30-day rolling. Never re-`setAllowance` an existing key when adding a payee.
- Practical cap ~10 payees per role key.

### Compliance checks before every payout

| # | Check | Source | Enforcement |
|---|---|---|---|
| 1 | Wallet on invoice == wallet on file | beneficiary registry | agent (chain backs it: allowlist) |
| 2 | Payee not sanctioned | EU consolidated list, OFAC SDN, CZ national list | agent |
| 3 | Wallet not sanctioned | OFAC SDN ETH addresses | agent |
| 4 | Firm licence/warnings (companies) | Mostly Right dataset (version id logged) | agent |
| 5 | Country risk | EU high-risk third countries, FATF grey list | agent (warn/review) |
| 6 | Duplicate invoice, amount anomaly, instruction-like text in PDF | store + extractor | agent |
| 7 | Amount within payee limit | Roles `allowances(key)` | **chain** |
| 8 | Token is EURC, recipient in allowlist | Roles conditions | **chain** |
| 9 | Issuer is a MiCA EMT issuer, reserves attested | ESMA interim register (Circle EU), latest attestation | agent |
| 10 | Wallet ownership proof | EIP-712 signature from the contractor at onboarding | agent |

Tax/accounting: CZK at the ČNB rate of the payout day, reverse-charge VAT note, withholding assessment, Travel Rule note for off-ramp > €1 000. Every rule is labelled `chain` or `agent`.

## 4. Repo layout

```
src/routes/            TanStack Start routes (thin) + api/ routes
src/components/        UI (shadcn/ui based)
src/lib/agent/         providers/, extract.ts, validate.ts, screen.ts, issuer.ts, explain.ts, pipeline.ts
src/lib/roles/         constants.ts, abi.ts, conditions.ts, install.ts, errors.ts, allowance.ts
src/lib/chain/         safe.ts, balances.ts, clients.ts
src/lib/reports/       remittance.ts, ledger.ts, audit.ts, cnb.ts, rails.ts
src/lib/store/         sqlite.ts, schema.sql, repos.ts
src/lib/thyme/         client.ts (API + webhook trigger), types.ts
thyme/functions/payroll-run/   Thyme Flow task (defineTask) + permissions.json
demo/                  payees.json, invoices/*.pdf, make-invoices.ts
config/                rails.json (sourced assumptions), lists.json (dated risk tables)
scripts/               fork-test.ts, gen-agent-key.ts, seed.ts
pitch/                 pitch site (Russian), assets
Dockerfile, railway.toml, .env.example
```

## 5. Work breakdown

| # | Stream | Deliverable | Target |
|---|---|---|---|
| 0 | Scaffold | TanStack Start app, Tailwind + shadcn, wagmi/ConnectKit, SQLite, Dockerfile, `railway up` live with /api/health. | Mon 17:00 |
| 1 | Chain | `lib/roles` + `lib/chain` ported, fork test green, Safe tx builder in the UI. | Mon 18:00 |
| 2 | Agent | Provider abstraction, extraction, validation, screening lists, issuer check, payout. CLI end to end on Sepolia. | Mon 20:00 |
| 3 | UI | Connect, dashboard, invoice flow (chat-like), beneficiary card + Safe tx, beneficiaries, agents, payouts. | Tue 00:00 |
| 4 | Reports | Remittance advice, ledger CSV/JSON, audit JSONL, ČNB FX, comparison card + sources drawer. | Tue 02:00 |
| 5 | Thyme | Flow task uploaded; executable with webhook; our trigger + status read; shown in the agents page. | Tue 04:00 |
| 6 | Hardening | Fraud + injection path, "force", kill switch, Etherscan links, timers. Two full rehearsals on Sepolia. | Tue 08:00 |
| 7 | Submission | README "Built during the hackathon", AI Act Art. 50 line in chat, slides, repo link. | Tue 12:30 |

## 6. Inputs needed from the team

- [ ] LLM access: AWS SSO login (then we deploy the Bedrock proxy) **or** an Anthropic API key for Railway.
- [ ] Sepolia ETH to the owner wallet and the agent address (printed by `scripts/gen-agent-key.ts`). EURC: buy on the WETH/EURC 0.3 % pool or farm the Circle faucet.
- [ ] WalletConnect (Reown) project id, Mostly Right free key. Railway variables only.
- [ ] Thyme: a Sepolia Roles profile on the demo Safe in the Flow console, a management login for the CLI.
- [ ] Reply to the organisers' email disclosing Thyme. Book the ČNB mentor slot (Tue 07:30–09:00).

## 7. Risks

| Risk | Mitigation |
|---|---|
| No LLM access from Railway | Anthropic key fallback; Mock provider keeps the UI demoable |
| EURC supply too low | Buy on pool; size invoices accordingly |
| Bedrock PDF quirks | Smoke test first; `format: 'pdf'`, fixed document name; PNG fallback |
| Thyme path not ready | Own-key path is primary; Thyme shown as scheduler only |
| Live tx fails on stage | Rehearse twice; keep screenshots and a recording |
| Public repo leaks | `.env` ignored, data/ ignored, review diff before every push |
