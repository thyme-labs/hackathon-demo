# Thyme Payroll: technical details

Companion to [README.md](README.md). Every number below is taken from a file in this repository or a cited URL.

## Architecture

```
Railway service "web"   TanStack Start (React 19 SSR, file routes, server functions, API routes), Bun runtime
  UI                    Tailwind 4 + shadcn/ui: /connect, /dashboard, /invoices, /beneficiaries, /agents, /payouts, /reports, /settings, /onboarding
  server fns            src/lib/server/*.fns.ts (invoices, payouts, beneficiaries, thyme onboarding, reports), all behind tenantMiddleware
  API routes            POST /api/invoices/upload, GET /api/thyme/pending, POST /api/webhooks/thyme, /api/auth/*, /api/reports/*, /api/demo/*, GET /api/health
  lib/agent             providers (bedrock | anthropic | mock), extract (Haiku 4.5, forced tool, temperature 0), checks/* (20), severity.ts, score.ts, explain (Sonnet 4.5)
  lib/thyme             HTTP client for the Thyme management API, executor, inbound webhook parsing
  lib/roles             viem encoders for Zodiac Roles v2.1.1 conditions and allowances (fork-tested, scripts/fork-test.ts)
  lib/reports           remittance.ts, ledger.ts, audit.ts, cnb.ts, fx.ts, rails.ts, calendar.ts
  store                 SQLite (bun:sqlite) on a Railway volume, schema.sql + migrations/, tenant-scoped repos
Thyme Flow              task thyme/functions/pay-invoice (cron every minute + webhook); executes EURC.transfer from the company Safe via a Roles profile, gas sponsored by Thyme Lift
Chain                   Ethereum Sepolia (11155111); Safe 1.4.1 / 1.5.0; Zodiac Roles v2.1.1 (mastercopy 0xF2964CE6161ce0e75964Fe7927cE114cb0B283D5); Circle EURC 0x08210F9170F89Ab7658F0B5E3fF39b0E03C594D4 (6 dp)
Models                  Amazon Bedrock eu-central-1: eu.anthropic.claude-haiku-4-5-20251001-v1:0 (extraction), eu.anthropic.claude-sonnet-4-5-20250929-v1:0 (explanations)
```

Thyme Flow is the only execution layer. The app reaches it exclusively through the public HTTP API and webhooks (`src/lib/thyme/client.ts`); no Thyme source code is in this repository. `PAYMENT_EXECUTOR=simulated` replaces the rail with labelled simulated payouts for local runs and the jury demo tenant.

Sessions are Sign-In with Ethereum (`src/lib/server/session.ts`): an EIP-4361 message for chain 11155111 signed by the connected wallet and verified with viem, or an anonymous demo session. The session is an HMAC-signed token in the httpOnly cookie `tp_session` (TTL 7 days; nonce cookie 5 minutes; Issued At within 10 minutes of the server clock). The tenant id is the lower-case owner address (`anon:<id>` for demo sessions); every repository call runs inside `runWithTenant`, so one SQLite file serves many isolated workspaces.

## Onboarding over the Thyme API

`src/lib/server/thymeOnboarding.ts`, steps shown in `/onboarding` with Retry on each:

1. **Safe** — the owner connects MetaMask (or the app runs as a Safe App) and picks a 1/1 Safe they own on Sepolia.
2. **Prepare** — `client.preparePayrollProfile({ projectId, alias, safeAddress, ownerAddress })` → `POST /api/v1/profiles` with `kind: safe_roles`. Thyme returns the profile id, the predicted Roles proxy and executor Safe, the role key and one prepared `Safe.execTransaction`. The alias is derived from the Safe, so repeating the call resumes the pending row; if Thyme already knows the Safe, the app **adopts the existing profile** (`adoptExistingProfile`) instead of failing.
3. **Owner signs** — one transaction from MetaMask (MultiSend: enable the Roles module, assign the role, scope `EURC.transfer(address,uint256)`). Example on Sepolia: [`0xd469208c…36d6`](https://sepolia.etherscan.io/tx/0xd469208c609125c1a941a427dda7782d2a575f69ab4ff6336ee754eb51fa36d6).
4. **Setup** — `POST /api/v1/profiles/{id}/setup` with the tx hash; Thyme verifies the receipt (`setup_not_mined` is retried) and marks the profile `active`.
5. **Executable + webhook** — the app creates the `pay-invoice@v1` executable (function id in `thyme/README.md`) with args `{ apiUrl, safeAddress }` and the `THYME_PULL_TOKEN` secret binding, then a run-only webhook. The webhook URL is stored as a credential in `settings` and never leaves the server.

What the scope lets Thyme do and not do is shown before signing (`THYME_SCOPE`): can call `EURC.transfer` from this Safe, only when the agent hands over an approved payout, gas sponsored; cannot call `approve()` or any other function, any other token or contract, change owners or modules, or delegatecall.

## Invoice pipeline

Upload → `extract` (PDF document block; the system prompt says the document is data; the tool schema has a `suspicious_text` array the model fills instead of obeying) → `pdf_forensics` and `invoice_integrity` on the raw bytes and extracted fields → the remaining checks in the order of `src/lib/agent/checks/index.ts` (`fx_rate` precedes `budget` because it sets the EUR amount) → `computeScore` → `decideStatus` → payout or hold. Sonnet 4.5 writes `decision_text`; its model id and prompt hash are stored with the invoice and printed on the remittance advice.

| id | tier | data source | enforcement |
|---|---|---|---|
| sanctions_person_entity | critical | EU consolidated list, OFAC SDN, CZ national list (exact, token, fuzzy) | agent |
| sanctions_wallet | critical | OFAC SDN ETH addresses, EU list remarks | agent |
| wallet_matches_file | critical | invoice wallet vs registry wallet | agent (chain allowlist backs it) |
| known_beneficiary | high | registry status, trust score, totals | agent |
| budget | high | payout ledger 30 days vs monthly limit; Roles `allowances(key)` when readable | agent (chain in next Thyme release) |
| invoice_integrity | high | invoice store + extracted fields | agent |
| country_risk | high | `config/lists.json` (EU regimes, FATF, EU high-risk) | agent |
| payment_pattern | high | ledger + invoice store, 24 h / 7 d windows (ČNB synthetic AML 2Q2026 calibration) | agent |
| payee_detail_change | high | audit_log events, cooling cap (min of EUR 500 and 50 % of limit in first 24 h) | agent |
| pdf_forensics | high | pdf-lib scan of objects and content streams | agent |
| fx_rate | medium | Tatum → Frankfurter (ECB) → static; ČNB daily fixing | agent |
| issuer_backing | medium | ESMA EMT register, `config/issuers.json`, EURC supply via RPC | agent |
| firm_licence_warnings | medium | Mostly Right dataset (version logged); companies only | agent |
| ownership_proof | medium | EIP-712 signature on file, viem (EIP-1271 aware) | agent |
| pep_screening | medium | Wikidata SPARQL, OpenSanctions oligarchs; persons only | agent |
| travel_rule_readiness | medium | `config/originator.json`, registry, Reg. (EU) 2023/1113 Art. 14(5)/16(2) | agent |
| eurc_blacklist | medium | EURC `isBlacklisted`, `paused`, admin roles (multicall) | agent |
| safe_roles_health | medium | Safe `isModuleEnabled`, Roles avatar/target, EURC `balanceOf` | chain |
| transfer_preflight | medium | `eth_call`/`estimateGas` of the exact transfer and `execTransactionWithRole`; Roles reverts decoded | chain |
| public_footprint | low | Apify search summarised by the model | agent |

Full descriptions: `src/lib/agent/descriptions/checks.ts`.

## Scoring (`src/lib/agent/score.ts`, `severity.ts`)

```
penalty(check) = weight × FAIL_MULTIPLIER[tier]   (critical 4, high 2.5, medium 1.5, low 1)
               = weight × WARN_MULTIPLIER[tier]   (critical 1.5, high 1, medium 0.6, low 0.4)
raw   = max(0, 100 − Σpenalty / Σweight(counted) × 100)
score = min(raw, cap)   cap = 10 on any critical fail, 40 on any high fail, 70 on ≥ 2 critical warns
```

A skip is neutral (no penalty, weight leaves the denominator) except that a critical or high check skipped because its source was unavailable is scored as a warning. The status decision is separate: any fail → `rejected`; unknown, non-active or trust < 60 beneficiary, or auto-pay off → `needs_approval`; otherwise `score ≥ AUTO_PAY_THRESHOLD` (default 100, editable in Settings) → `approved`. Suggested monthly limit for a new payee: 2.5 × first invoice, rounded up to EUR 100.

## Payout execution and reconciliation

```
app  --POST webhook {apiUrl, invoiceId}-->  Thyme executable (pay-invoice@v1)
app  <--GET /api/thyme/pending (X-Thyme-Token)  task picks one payout (oldest pending, or invoiceId)
app  <--POST /api/webhooks/thyme submitted      task returns EURC.transfer(payee, amount)
chain <--execTransactionWithRole                Thyme executor through the Roles profile, Lift gas
app  <--POST /api/webhooks/thyme confirmed|failed   onSuccess / onFail callbacks
app  --GET /api/v1/executions/{id}              status and logs on demand
```

One payout per run by design. The task has a balance guard: with `safeAddress` set it returns `canExec: false` ("Insufficient EURC in the Safe") instead of submitting a reverting transfer; the app maps that to payout `failed`. Webhook callbacks are authenticated with the shared `X-Thyme-Token` and keyed by `thyme_execution_id` on the payout row (`src/routes/api/webhooks/thyme.ts`). `retryPayout` (`src/lib/server/payouts.fns.ts`) is idempotent: a row Thyme still reports as running is left alone, a second click reports the in-flight row, and a retry of a failed row creates a new payout linked to the same invoice. Rows pending or submitted longer than the rail should need are flagged so the owner can retry, check or discard them.

## Data model (`src/lib/store/schema.sql`, `migrations/`)

`beneficiaries` (status new/active/paused/blocked, wallet, monthly_limit_eur, trust_score, totals, tax id, ownership proof), `beneficiary_wallets` (several approved wallets per payee), `invoices` (extracted fields, checklist and scoring snapshot JSON, decision, model id, prompt hash, PDF hash), `payouts` (amount_eur/eurc, fx and ČNB rates, tx hash, gas, executor, thyme_execution_id, status), `agents_v2`, `audit_log` (mirrored to the hash-chained JSONL), `settings_v2` (per-tenant keys incl. Thyme ids and the webhook URL), `_migrations`. All tenant tables carry the tenant id; the `_global` tenant holds the generated session secret.

## Security notes

- **No keys in the app.** The owner's key stays in MetaMask or Safe{Wallet}; Thyme's executor key stays with Thyme; the app stores only ids, the webhook URL and the pull token.
- **What `THYME_API_KEY` can do:** manage profiles and executables in one Thyme project (`profiles:write`, `executables:write`). It cannot move funds: every execution passes through the Roles scope on the Safe, so the worst case is a reverted `EURC.transfer` to an allow-listed wallet. The owner's kill switch is disabling the module on the Safe.
- **Tenant isolation.** SIWE-derived tenant id on every row; server functions run under `tenantMiddleware`; demo tenants never reach the real rail.
- **Audit chain.** `hash = sha256(prev_hash + canonical JSON)` per event, genesis `0`×64, `verifyChain` re-checks the file; secrets, RPC URLs and PDFs are redacted or stored as hashes only (`src/lib/reports/audit.ts`).
- **Prompt injection.** Hidden text is found deterministically before any model reads the page; the model's output is schema-validated; the recipient never comes from the document.
- **Public RPC only.** `SEPOLIA_RPC_URL` is a public endpoint; no private infrastructure is referenced in this repository.

## Demo scenarios

27 synthetic invoices in `demo/invoices/` with expected outcomes in `demo/payees.json` and `demo/README.md`: happy paths in EUR/USD/GBP/INR, a new beneficiary, a swapped-wallet fraud (`INV-0432`), white 4 pt prompt injection, line-item injection, hidden amount rewrite, a printed "score 100" stamp, a duplicate, an amount anomaly, over-limit, three-way structuring, an OFAC SDN wallet (Lazarus Group entry #27307), an EU-listed name (Garantex, EU.12747.39), FATF black and grey list countries, a Cyrillic homoglyph name, IBAN-only, stale dates, a Safe that is short of EURC, a USDT-denominated invoice. The mock provider reads each PDF's expected extraction from its `Subject` metadata, so the whole pipeline runs without a model.

## Environment variables (names only)

`DATABASE_PATH`, `AUDIT_LOG_PATH`, `SEPOLIA_RPC_URL`, `VITE_WALLETCONNECT_PROJECT_ID`, `LLM_PROVIDER`, `AWS_REGION`, `BEDROCK_MODEL_EXTRACT`, `BEDROCK_MODEL_REASON`, `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL_EXTRACT`, `ANTHROPIC_MODEL_REASON`, `TATUM_API_KEY`, `APIFY_TOKEN`, `MOSTLYRIGHT_API_KEY`, `THYME_API_URL`, `THYME_API_KEY`, `THYME_PROJECT_ID`, `THYME_FUNCTION_ID`, `THYME_PULL_TOKEN`, `THYME_WORKSPACE_ID`, `THYME_EXECUTABLE_ID`, `THYME_PAY_WEBHOOK_URL`, `PAYMENT_EXECUTOR`, `AUTO_PAY_THRESHOLD`, `APP_URL`, `PORT`, `SESSION_SECRET`, `DEMO_INVOICES_DIR`, `DEMO_UNICODE_FONT`, `AGENT_OFFLINE`. See `.env.example`.

## Local run

```bash
bun install && cp .env.example .env     # LLM_PROVIDER=mock, PAYMENT_EXECUTOR=simulated need no keys
bun run dev                              # http://localhost:3000
bun run demo:invoices                    # regenerate demo/invoices/*.pdf and demo/payees.json
curl -F file=@demo/invoices/INV-0401-marko.pdf http://localhost:3000/api/invoices/upload
```

The Flow task runs locally with `thyme run` from `thyme/` (`thyme/README.md`).

## Known limitations

- Per-beneficiary monthly limits are agent-enforced today; on-chain Roles allowances on Thyme's proxy are the next Thyme release (encoders in `src/lib/roles`).
- Testnet only (Sepolia); 1/1 Safes only; one payout per Flow run; the webhook cannot yet name the invoice (v2 release with an inline `defineTask` schema).
- Apify, Mostly Right, Tatum are optional; without keys the checks skip or warn and the invoice waits for the owner.
- PEP data is Wikidata and the OpenSanctions oligarch table only; no commercial PEP, adverse media or VIES validation yet.
- Demo reset and the audit log endpoints are unauthenticated on the demo URL; Bedrock credentials on Railway are daily SSO credentials.
- A hosted executor (Thyme) is the honest MiCA caveat; the production story for a bank is the agent in its own AWS account.
