# Thyme Flow: `pay-invoice`

Thyme Flow is the payment rail of Thyme Payroll. This directory is a standalone
Flow project (own `package.json`) with one task, `pay-invoice`. Thyme runs it on
a cron (every minute) and on a webhook; the task pulls approved payouts from our
app, returns a single `EURC.transfer`, and Thyme executes it from the company
Safe through a Roles profile with sponsored gas. The task never holds a key, and
neither does the app: the payroll app performs the whole Thyme onboarding for the
user's own Safe over the HTTP API (prepare profile -> owner sends one tx from
MetaMask -> setup -> create executable -> create webhook) and only ever talks to
Thyme through that API and webhooks.

## Uploaded release

| Deployment | Workspace | Project | Tag | Function id |
|---|---|---|---|---|
| `https://dev.api-http.thyme.sh` | `hackathon` (`nn749sjw8rxv7n25kdnqp4md0n8gjke1`) | `payroll` (`kx7de75y2pds2hnbqj5k0cfr3h8gksp4`) | `v1` | _not uploaded yet: the upload is refused with `No active Functions subscription` until the workspace has a Flow plan_ |

Upload (CLI 0.11.0, Deno 2.9.4; bump the tag whenever the task or its manifest changes):

```bash
cd thyme
THYME_API_URL=https://dev.api-http.thyme.sh thyme upload pay-invoice \
  --workspace nn749sjw8rxv7n25kdnqp4md0n8gjke1 --project kx7de75y2pds2hnbqj5k0cfr3h8gksp4 --tag v1 --ci
```

The printed `Task ID` is the function id: put it in the table above and in the app's
`THYME_FUNCTION_ID`. Ids are configuration, not secrets.

```text
app  --POST webhook {apiUrl, invoiceId}-->  Thyme executable (pay-invoice@v1)
app  <--GET /api/thyme/pending-------------  task: picks one payout
app  <--POST /api/webhooks/thyme submitted-  task: returns EURC.transfer(payee, amount)
chain <--execTransactionWithRole------------  Thyme (Roles profile on the Safe, Lift gas)
app  <--POST /api/webhooks/thyme confirmed|failed  task callbacks (onSuccess / onFail)
app  --GET /api/v1/executions/{id}--------->  Thyme management API (status, logs)
```

One payout per run by design: Roles profiles submit one call per run.

## Files

| Path | Purpose |
|---|---|
| `functions/pay-invoice/index.ts` | The task (`defineTask`): pull, guard, encode, callbacks. |
| `functions/pay-invoice/permissions.json` | Declares the only call the release may make: `transfer(address,uint256)` on EURC `0x08210F9170F89Ab7658F0B5E3fF39b0E03C594D4` on chain 11155111. Uploaded with the code; the profile owner must allow the same on-chain. |
| `functions/pay-invoice/args.json` | Local args (`apiUrl`). Not uploaded. |
| `functions/pay-invoice/storage.json` | Local storage seed. Cloud storage is separate. |
| `functions/pay-invoice/.env.example` | Task-local secret for local runs (`THYME_PULL_TOKEN`). |
| `.env.example` | `RPC_URL`, `SIMULATE_ACCOUNT` for `thyme run`. |
| `executable.example.json` | Body for creating the cloud executable (fill the IDs, save as `executable.json`, which is ignored). |

### Task args

| Arg | Required | Meaning |
|---|---|---|
| `apiUrl` | yes | Origin of the payroll app, e.g. `https://payroll.example.com`. |
| `invoiceId` | no | Pay exactly this invoice. Set by the app on webhook runs. Cron runs omit it and take the oldest pending payout. |
| `safeAddress` | no | When set, the run is skipped if the Safe holds less EURC than the invoice needs (saves a reverting transaction). |
| `pullToken` | no | Local runs only. In the cloud the `THYME_PULL_TOKEN` secret binding is used instead. |

Webhook custom args replace the saved args entirely, so the app always sends
`{ "apiUrl": ..., "invoiceId": ... }` (plus `safeAddress` when it knows the Safe).

### Storage (per executable)

`runSeq`, `lastExecutionId`, `lastPayoutId`, `lastInvoiceId`, `lastWallet`, `lastAmountEurc`,
`lastRunAt` are written in `run` and only committed when the transfer confirms; `onSuccess`
adds `lastTxHash`, `lastConfirmedAt` and appends to `paidPayoutIds` (last 50). A pending
payout that is already in that list is refused: this is the double-pay guard for the case
where a `confirmed` callback never reached the app.

`runSeq` drives the synthetic execution id `flow-<seq>-<first 8 hex of the account>` sent
on every callback. A failed run's storage is discarded, so `onFail` recomputes the same
id from `runSeq + 1`, posts it, and then advances `runSeq` itself.

## Local run

Needs Bun, Deno (for `thyme run`), and the app running locally.

```bash
cd thyme
bun install
cp .env.example .env                                   # set SIMULATE_ACCOUNT to the demo Safe
cp functions/pay-invoice/.env.example functions/pay-invoice/.env   # THYME_PULL_TOKEN = the app's value
# functions/pay-invoice/args.json points at http://localhost:3000; change if the app runs elsewhere

bunx thyme run pay-invoice                             # pull + encode, prints the call, no broadcast
bunx thyme run pay-invoice --simulate                  # also eth_call the transfer from SIMULATE_ACCOUNT
bunx thyme run pay-invoice --callback onSuccess --persist   # exercise the confirmed callback
bunx thyme run pay-invoice --callback onFail:reverted       # exercise the failed callback
bun run typecheck
```

`thyme run` never signs or broadcasts. The CLI checks every returned call against
`permissions.json` (verified with CLI 0.11.0). `THYME_PULL_TOKEN` reaches `ctx.secrets`
under that name in the local runtime (verified); if a cloud deployment ever filtered
`THYME_`-prefixed secret keys, bind the same secret under another `envKey` and adapt
`resolveToken` in the task.

## Cloud setup (operator steps)

Everything below is done by a workspace owner or admin. IDs and URLs printed by
these commands are configuration, the webhook URL and API keys are credentials:
put them in Railway variables, never in this repo.

### 0. Point the CLI at the right deployment

```bash
export THYME_API_URL='https://YOUR_FLOW_API_HOST/http'   # HTTP API base from the Console docs, not the Console URL
thyme api-url                                            # must print that URL with source "env"
```

The CLI's packaged default is `https://flow.thymelabs.io/http` (docs: `/cli/api-url`).

### 1. Log in with management access

```bash
thyme login --management --browserless
```

It prints `Go to: <url>` and `Enter code: <code>`. Approve in the browser (an
owner/admin picks the workspace). The command polls for up to five minutes and
stores the credential in `~/.thyme/config.json`. Then:

```bash
thyme projects list                       # -> PROJECT_ID (and the workspace id)
thyme chains list                         # Sepolia (11155111) must be enabled
thyme profiles list --project PROJECT_ID  # -> PROFILE_ID of the Sepolia Roles profile, status "active"
```

### 2. Roles profile on the user's Safe (done by the payroll app, owner wallet)

The payroll app creates the Roles profile itself over the management API, so the
user never opens the Thyme Console. `src/lib/thyme/client.ts`:

1. `prepareRolesProfile` = `POST /api/v1/profiles` with `kind: "safe_roles"`, the Safe,
   its 1/1 owner and the allowlist below. Thyme returns a ready
   `transaction { to: safe, value: "0x0", data }` plus the predicted Roles proxy and
   executor Safe.
2. The owner sends `transaction` from MetaMask (plain `eth_sendTransaction` on Sepolia,
   never through a Safe app or a bundler) and the app waits for the receipt.
3. `confirmRolesSetup` = `POST /api/v1/profiles/{id}/setup { txHash }`. Thyme verifies the
   mined calldata and the Roles module on chain, provisions sponsorship and answers
   `setupStatus: "active"`. `409 setup_not_mined` means call it again later.

Allowed on chain, and nothing else:

- target `0x08210F9170F89Ab7658F0B5E3fF39b0E03C594D4` (Circle EURC, Sepolia)
- function `transfer(address,uint256)` (selector `0xa9059cbb`)

A Thyme profile allowlist limits target and selector, not arguments: with
`transfer` allowed, the task chooses recipient and amount. The chain guarantees
(label `chain`): only EURC, only `transfer`, only from this Safe, only through Thyme.
Per-beneficiary monthly limits are enforced by the agent for now (label `agent`).
Verify independently, no login needed:

```bash
thyme verify roles-profile --profile PROFILE_ID --owner SAFE_ADDRESS --rpc-url https://ethereum-sepolia-rpc.publicnode.com
```

### 3. Upload the function release

```bash
cd thyme
thyme upload pay-invoice -w WORKSPACE_ID -p PROJECT_ID --tag v1
thyme functions list --project PROJECT_ID --name pay-invoice   # -> FUNCTION_ID
```

Tags are immutable; changed code or manifest needs a new tag (`v2`, ...). Upload
creates code only; nothing runs yet.

### 4. Create the pull-token secret

Generate one random value, store it as the app's `THYME_PULL_TOKEN` Railway
variable, and create the same value as a project secret:

```bash
thyme secrets create --project PROJECT_ID --key THYME_PULL_TOKEN --value "$THYME_PULL_TOKEN"   # -> SECRET_ID
```

Secrets are write-only and are only visible to executables that bind them.

### 5. Create the executable (cron every minute + secret binding)

Copy `executable.example.json` to `executable.json` (ignored), fill `PROJECT_ID`,
`FUNCTION_ID`, `PROFILE_ID`, `SECRET_ID`, the app origin and the Safe address.
`args` is a JSON-encoded string.

```json
{
  "projectId": "PROJECT_ID",
  "functionId": "FUNCTION_ID",
  "profileId": "PROFILE_ID",
  "name": "pay-invoice",
  "trigger": { "type": "cron", "cronspec": "* * * * *" },
  "args": "{\"apiUrl\":\"https://YOUR_APP_HOST\",\"safeAddress\":\"0xYOUR_DEMO_SAFE\"}",
  "secretBindings": [{ "secretId": "SECRET_ID", "envKey": "THYME_PULL_TOKEN" }],
  "gasMode": "sponsored",
  "sandboxRuntime": "daytona"
}
```

```bash
thyme api POST /api/v1/executables --data-file executable.json --idempotency-key create-pay-invoice-v1
# -> EXECUTABLE_ID
thyme executables get EXECUTABLE_ID       # repeat until "status": "active"
```

`paused` right after creation means the profile does not cover
`transfer(address,uint256)` on EURC: fix the scope in the Console (step 2), then
`thyme executables resume EXECUTABLE_ID`. Roles profiles require `gasMode: sponsored`.

To bind or change secrets later: `thyme executables update EXECUTABLE_ID secrets --data '{"secretBindings":[{"secretId":"SECRET_ID","envKey":"THYME_PULL_TOKEN"}]}'` (replaces all bindings).

### 6. Create the webhook the app triggers

```bash
thyme executables webhook-create EXECUTABLE_ID --name "payroll-app"
thyme executables webhooks EXECUTABLE_ID            # metadata only, the URL is never shown again
```

The response contains the URL once. It is a run-only credential: anyone holding it
can spend this executable's compute and gas. Store it as `THYME_PAY_WEBHOOK_URL`.
Lost it: `thyme webhooks rotate WEBHOOK_ID`. Exposed: `thyme webhooks revoke WEBHOOK_ID`.

### 7. API key for reading executions

**Console -> API Keys**: create a key for the app with `executions:read` (add
`executables:run` only if the management-run fallback is wanted). Store it as
`THYME_API_KEY`. If the key is not workspace-bound, also set `THYME_WORKSPACE_ID`.

### 8. Smoke test

```bash
thyme executables simulate EXECUTABLE_ID                         # dry run, no tx, no storage commit
thyme executions list --project PROJECT_ID --limit 5             # -> EXECUTION_ID
thyme executions logs EXECUTION_ID                               # task logger lines
```

With an approved invoice waiting in the app (status `approved`, payout `pending`):

```bash
curl -X POST "$THYME_PAY_WEBHOOK_URL" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: payout-INVOICE_ID-1' \
  --data '{"apiUrl":"https://YOUR_APP_HOST","invoiceId":"INVOICE_ID"}'
```

Thyme holds the request up to 55 s and answers `200` with the execution status and
hashes, or `202` with `data.resultUrl` to poll. Same `Idempotency-Key` + same body
within 24 h returns the original execution; a different body with the same key is
`409 idempotency_conflict`; a run already in progress is `409 execution_in_progress`.

### 9. Ship a new version

```bash
thyme upload pay-invoice -w WORKSPACE_ID -p PROJECT_ID --tag v2
thyme executables pause EXECUTABLE_ID
thyme executables set-function EXECUTABLE_ID --function FUNCTION_V2_ID \
  --args '{"apiUrl":"https://YOUR_APP_HOST","safeAddress":"0xYOUR_DEMO_SAFE"}'
thyme executables get EXECUTABLE_ID       # until pendingFunctionSwitch is gone
thyme executables resume EXECUTABLE_ID
```

### 10. Kill switch

`thyme executables pause EXECUTABLE_ID` stops new runs (cron and webhook) but does
not undo an in-flight transaction. The on-chain kill switch is the owner revoking
the role membership in the Console (Profiles) or on our own Roles module.

## Environment the app needs (Railway variables)

| Variable | Used by | Meaning |
|---|---|---|
| `THYME_API_URL` | `src/lib/thyme/env.ts` | Management API base incl. prefix (`https://dev.api-http.thyme.sh` for the hackathon). Defaults to the public `https://flow.thymelabs.io/http`. |
| `THYME_API_KEY` | `client.ts` | Management or project key: `profiles:write`, `executables:write`, `executions:read` (owner/admin). Credential. |
| `THYME_WORKSPACE_ID` | `client.ts` | Only for unbound keys (`X-Workspace-Id`). Optional. |
| `THYME_PROJECT_ID` | onboarding | The Thyme project holding the function, profile and executable (`kx7de75y2pds2hnbqj5k0cfr3h8gksp4`). |
| `THYME_FUNCTION_ID` | onboarding | The uploaded `pay-invoice` release (table at the top). |
| `THYME_PULL_TOKEN` | routes + `src/lib/thyme/inbound.ts` | Shared secret the task presents as `X-Thyme-Token` on both app routes. The in-app onboarding passes it to the executable as the `pullToken` task arg (saved args and every webhook call); a project secret bound as `THYME_PULL_TOKEN` works too. Empty = open (local dev only). |
| `PAYMENT_EXECUTOR` | `src/lib/env.ts` | `thyme` (default) or `simulated`. With `thyme` the app still records labelled simulated payouts until a Safe is enabled on `/onboarding`. |
| `APP_URL` | `client.ts` | Public origin of the app; sent to the task as `apiUrl`. |
| `PAYMENT_EXECUTOR` | `src/lib/payments/runner.ts` | `thyme` or `simulated` (labelled fake payouts when Thyme is not configured). |
| `THYME_EXECUTABLE_ID`, `THYME_PAY_WEBHOOK_URL` | `client.ts` | Optional, only for a pre-provisioned executable; the onboarding stores its own ids in the settings table (`thymeProfileId`, `thymeExecutableId`, `thymeWebhookUrl`). |

## Contract between the app and the task

Source of truth: `src/routes/api/thyme/pending.ts` and `src/routes/api/webhooks/thyme.ts`
(mirrored as zod schemas in `src/lib/thyme/inbound.ts`). Both routes check `X-Thyme-Token`
against `THYME_PULL_TOKEN` and run open when it is empty.

`GET {APP_URL}/api/thyme/pending`:

```json
{ "token": "EURC", "chainId": 11155111,
  "payouts": [ { "payoutId": "pay_…", "invoiceId": "inv_…", "wallet": "0x…", "amountEurc": "600000000" } ] }
```

Rows are payouts with `status = pending`, `executor = thyme`, an `approved`/`paying`
invoice and a wallet on file, oldest first. `amountEurc` is `payouts.amount_eurc`: EURC
base units (6 dp) as a decimal string. The task takes the first row (or the one named by
`args.invoiceId` on webhook runs), refuses a queue that is not `EURC` on `11155111`, and
returns `canExec: false` when nothing is pending.

`POST {APP_URL}/api/webhooks/thyme`, one call per state change:

| `status` | When | Fields sent |
|---|---|---|
| `submitted` | task handed the transfer to Thyme (before broadcast) | `executionId`, `payoutId`, `invoiceId` |
| `confirmed` | receipt in (`onSuccess`) | `executionId`, `payoutId`, `invoiceId`, `txHash`, `blockNumber`, `gasUsed`, `error: null` |
| `failed` | `onFail`: reverted, bundler rejection or timeout | `executionId`, `invoiceId` (webhook runs only), `stage`, `error` (`"<stage>: <reason>"`), `txHash` when known |

`executionId` is the task's synthetic run id (`flow-<seq>-<account8>`), identical across
the three callbacks of one run: the route stores it in `payouts.thyme_execution_id` on
`submitted`, which is how a cron-run `failed` (no `payoutId`: a failed run's storage is
discarded) still finds its payout through `payouts.byExecutionId`. Thyme's real execution
id is only known app-side, from the webhook response (`ExecutePayoutResult.thymeExecutionId`)
or the executions API. Extra keys (`stage`, `userOpHash`, `account`, `amountEurc`, `source`,
`at`) are sent for logs and are stripped by the route's schema. `txHash` is sent only when
it is a 32-byte hash, otherwise `null`, so the callback always passes the route's validation.

Callbacks are best effort (Thyme does not guarantee delivery); the app must stay
idempotent and may reconcile through `getExecution` / `listExecutions` in
`src/lib/thyme/client.ts`. `stage: timeout` is an unknown outcome: the transfer may still land.

## Limits worth knowing

- One call per run on Roles profiles; the task pays one invoice per run.
- 30 s per sandbox invocation; the task uses 8 s HTTP timeouts.
- Webhook: 60 new executions per minute per URL, body up to 256 KiB.
- Execution states: `pending`, `running`, `simulating`, `submitted`, `submitted_unknown`, `confirmed`, `failed`, `skipped`.
