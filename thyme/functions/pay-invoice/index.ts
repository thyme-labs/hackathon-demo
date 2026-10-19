import { defineTask, type JsonObject, type JsonValue, type ThymeContext, z } from '@thyme-labs/sdk'
import { type Address, encodeFunctionData, erc20Abi, formatUnits, getAddress, isAddress, parseUnits } from 'viem'

/**
 * pay-invoice: one EURC transfer per run.
 *
 * 1. GET {apiUrl}/api/thyme/pending (header X-Thyme-Token) -> approved payouts, oldest first.
 * 2. Take the first one, or the one named by args.invoiceId (webhook runs).
 * 3. POST "submitted" to {apiUrl}/api/webhooks/thyme, return EURC.transfer(payee, amount);
 *    Thyme executes it through the Roles profile on the Safe.
 * 4. onSuccess / onFail POST "confirmed" / "reverted" | "failed" to the same route.
 *
 * Roles profiles submit one call per run, so one payout per run by design.
 * The task never holds a key; Thyme signs through the customer-owned Safe.
 *
 * Wire contract: src/routes/api/thyme/pending.ts and src/routes/api/webhooks/thyme.ts.
 */

// Circle EURC on Ethereum Sepolia, 6 decimals. Public testnet address.
const EURC: Address = '0x08210F9170F89Ab7658F0B5E3fF39b0E03C594D4'
const EURC_DECIMALS = 6
const SEPOLIA_CHAIN_ID = 11155111
const HTTP_TIMEOUT_MS = 8_000
const PAID_HISTORY_SIZE = 50
const TX_HASH = /^0x[0-9a-fA-F]{64}$/

const schema = z.object({
  /** Origin of the payroll app, e.g. https://payroll.example.com */
  apiUrl: z.string().url(),
  /** Pay exactly this invoice (webhook runs). Cron runs leave it unset and take the oldest. */
  invoiceId: z.string().min(1).optional(),
  /** Local runs only. In the cloud bind the THYME_PULL_TOKEN secret instead. */
  pullToken: z.string().min(1).optional(),
  /** When set, the run is skipped if this Safe holds less EURC than the invoice needs. */
  safeAddress: z.address().optional(),
})

// zodExtended is a value export, so the schema's own output type is used instead of z.infer.
type Args = (typeof schema)['_output']
type Ctx = ThymeContext<Args>

const pendingPayoutSchema = z.object({
  payoutId: z.string().min(1),
  invoiceId: z.string().min(1),
  invoiceNumber: z.string().nullable().optional(),
  beneficiaryId: z.string().nullable().optional(),
  /** payee wallet; null when the invoice has none */
  to: z.string().nullable(),
  /** EURC base units (6 dp) as a decimal string, e.g. "600000000" for 600.00 EURC */
  amountEurc: z.string().min(1),
  amountEur: z.number().nullable().optional(),
})
const pendingResponseSchema = z.object({
  token: z.string().optional(),
  chainId: z.number().optional(),
  payouts: z.array(pendingPayoutSchema),
})
type PendingPayout = (typeof pendingPayoutSchema)['_output']

type Payable = { payoutId: string; invoiceId: string; label: string; payee: Address; amount: bigint }

type CallbackStatus = 'submitted' | 'confirmed' | 'failed' | 'reverted'
type CallbackPayload = { executionId: string; status: CallbackStatus } & Record<string, JsonValue>

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function resolveToken(ctx: Ctx): string | undefined {
  return ctx.secrets.THYME_PULL_TOKEN || ctx.args.pullToken
}

function headersFor(ctx: Ctx): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  }
  const token = resolveToken(ctx)
  if (token) headers['X-Thyme-Token'] = token
  return headers
}

function readString(storage: JsonObject, key: string): string | undefined {
  const value = storage[key]
  return typeof value === 'string' ? value : undefined
}

function readNumber(storage: JsonObject, key: string): number {
  const value = storage[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function readPaid(storage: JsonObject): string[] {
  const value = storage.paidInvoiceIds
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

/**
 * Synthetic execution id the app can correlate across submitted/confirmed/failed.
 * Thyme's own execution id is not visible inside the task. The sequence lives in
 * storage; a failed run's storage is discarded, so onFail recomputes the same id.
 */
function executionIdFor(account: Address, seq: number): string {
  return `flow-${seq}-${account.slice(2, 10).toLowerCase()}`
}

/** "600000000" (base units) or "600.5" (human) -> base units. */
function parseAmount(text: string): bigint | undefined {
  try {
    return text.includes('.') ? parseUnits(text, EURC_DECIMALS) : BigInt(text)
  } catch {
    return undefined
  }
}

function toPayable(ctx: Ctx, item: PendingPayout): Payable | undefined {
  const label = item.invoiceNumber ?? item.invoiceId
  if (!item.to || !isAddress(item.to)) {
    ctx.logger.warn(`Invoice ${label}: payee wallet missing or invalid, leaving it in the queue`)
    return undefined
  }
  const amount = parseAmount(item.amountEurc)
  if (amount === undefined || amount <= 0n) {
    ctx.logger.warn(`Invoice ${label}: amount "${item.amountEurc}" is not a positive EURC amount`)
    return undefined
  }
  return { payoutId: item.payoutId, invoiceId: item.invoiceId, label, payee: getAddress(item.to), amount }
}

async function fetchPending(ctx: Ctx): Promise<Payable[]> {
  const url = new URL('/api/thyme/pending', ctx.args.apiUrl)
  if (ctx.args.invoiceId) url.searchParams.set('invoiceId', ctx.args.invoiceId)
  const response = await fetch(url, {
    headers: headersFor(ctx),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  })
  if (!response.ok) {
    throw new Error(`GET ${url.pathname} failed: HTTP ${response.status}`)
  }
  const parsed = pendingResponseSchema.safeParse(await response.json())
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`)
    throw new Error(`Unexpected /api/thyme/pending payload: ${issues.join('; ')}`)
  }
  const { token, chainId, payouts } = parsed.data
  if (token !== undefined && token !== 'EURC') throw new Error(`Pending queue is in ${token}, this task pays EURC only`)
  if (chainId !== undefined && chainId !== SEPOLIA_CHAIN_ID) throw new Error(`Pending queue is for chain ${chainId}`)
  const payable: Payable[] = []
  for (const item of payouts) {
    const entry = toPayable(ctx, item)
    if (entry) payable.push(entry)
  }
  return payable
}

/** Best effort: a lost callback must never turn a confirmed transfer into a failure. */
async function notify(ctx: Ctx, payload: CallbackPayload): Promise<void> {
  const url = new URL('/api/webhooks/thyme', ctx.args.apiUrl)
  const body: JsonObject = { ...payload, source: 'thyme-flow', at: new Date().toISOString() }
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: headersFor(ctx),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    })
    if (!response.ok) {
      ctx.logger.warn(`Callback "${payload.status}" not accepted by the app: HTTP ${response.status}`)
    }
  } catch (error) {
    ctx.logger.warn(`Callback "${payload.status}" could not be delivered: ${describe(error)}`)
  }
}

/** Returns the Safe balance when it is lower than `amount`, otherwise undefined. */
async function safeShortfall(ctx: Ctx, safe: Address, amount: bigint): Promise<bigint | undefined> {
  try {
    const balance = await ctx.client.readContract({
      address: EURC,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [safe],
    })
    return balance < amount ? balance : undefined
  } catch (error) {
    ctx.logger.warn(`Safe balance check skipped: ${describe(error)}`)
    return undefined
  }
}

function txHashOrNull(value: string | undefined): string | null {
  return value && TX_HASH.test(value) ? value : null
}

export default defineTask({
  schema,

  async run(ctx) {
    const { logger } = ctx
    if (!resolveToken(ctx)) {
      logger.warn('No THYME_PULL_TOKEN bound: the payroll app will reject this pull unless it runs open')
    }

    const pending = await fetchPending(ctx)
    const wanted = ctx.args.invoiceId
    const payout = wanted ? pending.find((item) => item.invoiceId === wanted) : pending[0]
    if (!payout) {
      return {
        canExec: false,
        message: wanted ? `Invoice ${wanted} is not pending` : 'No pending payouts',
      }
    }

    // Double-pay guard. lastInvoiceId / paidInvoiceIds are only committed after a
    // confirmed transfer, so a hit means the app has not acknowledged a payment yet.
    const alreadyPaid =
      readPaid(ctx.storage).includes(payout.invoiceId) || readString(ctx.storage, 'lastInvoiceId') === payout.invoiceId
    if (alreadyPaid) {
      const lastTx = readString(ctx.storage, 'lastTxHash') ?? 'unknown tx'
      logger.warn(`Invoice ${payout.invoiceId} was already paid by this executable (${lastTx})`)
      return {
        canExec: false,
        message: `Invoice ${payout.invoiceId} already paid by this executable; refusing to pay twice`,
      }
    }

    const human = formatUnits(payout.amount, EURC_DECIMALS)
    if (ctx.args.safeAddress) {
      const shortfall = await safeShortfall(ctx, ctx.args.safeAddress, payout.amount)
      if (shortfall !== undefined) {
        const held = formatUnits(shortfall, EURC_DECIMALS)
        logger.error(`Safe ${ctx.args.safeAddress} holds ${held} EURC, invoice needs ${human}`)
        return { canExec: false, message: `Insufficient EURC in the Safe (${held} < ${human})` }
      }
    }

    const seq = readNumber(ctx.storage, 'runSeq') + 1
    const executionId = executionIdFor(ctx.account, seq)
    logger.info(`Paying ${human} EURC to ${payout.payee} for invoice ${payout.label} (run ${executionId})`)
    logger.info(`Execution account ${ctx.account}; one transfer per run`)

    ctx.storage.runSeq = seq
    ctx.storage.lastExecutionId = executionId
    ctx.storage.lastInvoiceId = payout.invoiceId
    ctx.storage.lastPayoutId = payout.payoutId
    ctx.storage.lastPayee = payout.payee
    ctx.storage.lastAmountEurc = payout.amount.toString()
    ctx.storage.lastRunAt = new Date().toISOString()

    await notify(ctx, {
      executionId,
      status: 'submitted',
      invoiceId: payout.invoiceId,
      payoutId: payout.payoutId,
      account: ctx.account,
      amountEurc: payout.amount.toString(),
    })

    return {
      canExec: true,
      calls: [
        {
          to: EURC,
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: 'transfer',
            args: [payout.payee, payout.amount],
          }),
        },
      ],
    }
  },

  async onSuccess(ctx, tx) {
    // Storage here is the committed state of the successful run, so these are ours.
    const seq = readNumber(ctx.storage, 'runSeq')
    const executionId = readString(ctx.storage, 'lastExecutionId') ?? executionIdFor(ctx.account, seq)
    const invoiceId = ctx.args.invoiceId ?? readString(ctx.storage, 'lastInvoiceId')
    const payoutId = readString(ctx.storage, 'lastPayoutId')

    ctx.storage.lastTxHash = tx.txHash
    ctx.storage.lastConfirmedAt = new Date().toISOString()
    if (invoiceId) {
      const history = readPaid(ctx.storage).filter((id) => id !== invoiceId)
      ctx.storage.paidInvoiceIds = [...history, invoiceId].slice(-PAID_HISTORY_SIZE)
    }
    ctx.logger.info(`Confirmed ${tx.txHash} in block ${tx.blockNumber} (gas ${tx.gasUsed})`)

    await notify(ctx, {
      executionId,
      status: 'confirmed',
      invoiceId: invoiceId ?? null,
      payoutId: payoutId ?? null,
      txHash: txHashOrNull(tx.txHash),
      userOpHash: tx.userOpHash ?? null,
      blockNumber: tx.blockNumber,
      gasUsed: Number(tx.gasUsed),
      error: null,
      account: ctx.account,
    })
  },

  async onFail(ctx, info) {
    // Storage here is the state from BEFORE the failed run (its writes were discarded), so the
    // failed run used runSeq + 1. Recompute its id so the app can match the "submitted" callback,
    // then advance the sequence so the next run does not reuse it.
    const seq = readNumber(ctx.storage, 'runSeq') + 1
    const executionId = executionIdFor(ctx.account, seq)
    ctx.storage.runSeq = seq
    const invoiceId = ctx.args.invoiceId
    const tx = info.txHash ? ` (tx ${info.txHash})` : ''
    ctx.logger.error(`${info.stage}: ${info.reason}${tx}`)
    if (info.stage === 'timeout') {
      ctx.logger.warn('Outcome unknown: the transfer may still land. Reconcile before retrying.')
    }

    await notify(ctx, {
      executionId,
      status: info.stage === 'reverted' ? 'reverted' : 'failed',
      invoiceId: invoiceId ?? null,
      stage: info.stage,
      error: `${info.stage}: ${info.reason}`,
      txHash: txHashOrNull(info.txHash),
      userOpHash: info.userOpHash ?? null,
      account: ctx.account,
    })
  },

  onSkip(ctx, info) {
    ctx.logger.info(`Skipped: ${info.message}`)
  },

  onError(ctx, info) {
    // run() threw before returning calls: nothing was submitted, nothing to report.
    ctx.logger.error(`Task error before submission: ${info.error}`)
  },
})
