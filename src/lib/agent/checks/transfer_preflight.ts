// Transfer dry-run: would the exact EURC transfer succeed right now? Leg (a) simulates EURC.transfer from
// the Safe (balance, blacklist, pause). Leg (b), when the role key is stored, simulates the Roles call
// Thyme's executor would make (membership + scope). The recipient is always a registry wallet.
import { type Address, getAddress, parseUnits } from 'viem'
import { erc20Abi } from '../../roles/abi'
import { EURC, EURC_DECIMALS } from '../../roles/constants'
import { type DecodedRolesRevert, explainRevert } from '../../roles/errors'
import { encodeErc20Transfer, encodeExecTransactionWithRole } from '../../roles/payout'
import { agentEnv } from '../env'
import { chainClient, classifyCallError, fmtEurc, offlineSkip, railAddresses, rpcHost, rpcSkip } from './_chain'
import { approvedWallets, type CheckContext, type CheckSpec, makeResult, shortAddr } from './context'

const spec = { id: 'transfer_preflight', label: 'Transfer dry-run', enforcement: 'chain', weight: 8 } as const

const STATIC_SOURCE = 'eth_call/estimateGas on Sepolia; Roles v2.1.1 execTransactionWithRole dry-run'

type LegA = { ok: true; gas: string } | { ok: false; reason: string; name: string }
type LegB = { ran: false } | { ran: true; ok: true } | { ran: true; ok: false; revert: DecodedRolesRevert }

/**
 * The approved wallet the rail will pay (store/repos.ts selectForPayout): the printed wallet when it is an
 * approved one, else the primary. An unapproved printed wallet is never dry-run.
 */
const payoutWallet = (ctx: CheckContext): Address | null => {
  const approved = approvedWallets(ctx)
  const printed = ctx.extracted.payment.wallet
  const pick = approved.find((w) => w.wallet === printed) ?? approved.find((w) => w.isPrimary) ?? approved[0]
  const wallet = pick?.wallet ?? ctx.beneficiary?.wallet ?? null
  return wallet ? getAddress(wallet) : null
}

export const run = async (ctx: CheckContext) => {
  const rail = railAddresses(ctx.store)
  const payee = payoutWallet(ctx)
  if (!payee) {
    return makeResult(spec, ctx, { status: 'skip', evidence: 'Dry-run runs once the owner has registered the wallet.', source: STATIC_SOURCE })
  }
  if (!rail.safe || rail.simulated) {
    return makeResult(spec, ctx, { status: 'skip', evidence: 'No Safe on file (simulated rail); nothing to dry-run.', source: STATIC_SOURCE })
  }
  const amountEur = ctx.out.amountEur ?? (ctx.extracted.invoice.currency === 'EUR' ? ctx.extracted.invoice.gross : null)
  if (amountEur === null) {
    return makeResult(spec, ctx, { status: 'skip', evidence: 'No EUR amount (FX failed); nothing to dry-run.', source: STATIC_SOURCE })
  }
  const units = parseUnits(amountEur.toFixed(EURC_DECIMALS), EURC_DECIMALS)
  if (units <= 0n) {
    return makeResult(spec, ctx, { status: 'skip', evidence: 'Zero amount; nothing to dry-run.', source: STATIC_SOURCE })
  }
  if (agentEnv.offline()) return offlineSkip(spec, ctx, 'transfer dry-run')

  const safe = rail.safe
  const client = chainClient()
  const amt = `${fmtEurc(units)} EURC`
  const transfer = { address: EURC, abi: erc20Abi, functionName: 'transfer', args: [payee, units], account: safe } as const

  let block: bigint
  try {
    block = await client.getBlockNumber()
  } catch (err) {
    return rpcSkip(spec, ctx, err)
  }

  // Leg (a): the token transfer itself, from the Safe.
  let legA: LegA
  try {
    await client.simulateContract(transfer)
    const gas = await client.estimateContractGas(transfer)
    legA = { ok: true, gas: gas.toString() }
  } catch (err) {
    if (classifyCallError(err) === 'transport') return rpcSkip(spec, ctx, err)
    const decoded = explainRevert(err)
    legA = { ok: false, reason: decoded.human, name: decoded.name }
  }

  // Leg (b): the Roles call Thyme's executor makes (membership + EURC.transfer scope). Needs the stored role key.
  let legB: LegB = { ran: false }
  if (rail.rolesProxy && rail.executorSafe && rail.roleKey) {
    try {
      await client.call({
        account: rail.executorSafe,
        to: rail.rolesProxy,
        data: encodeExecTransactionWithRole({ roleKey: rail.roleKey, target: EURC, data: encodeErc20Transfer(payee, units), shouldRevert: true }),
      })
      legB = { ran: true, ok: true }
    } catch (err) {
      if (classifyCallError(err) === 'transport') return rpcSkip(spec, ctx, err)
      legB = { ran: true, ok: false, revert: explainRevert(err) }
    }
  }

  const source = `eth_call/estimateGas on Sepolia via ${rpcHost()} at ${ctx.now.toISOString()}, block ${block}; Roles v2.1.1 execTransactionWithRole dry-run`
  const data = { payee, amount_units: units.toString(), amount_eur: amountEur, safe, executor_safe: rail.executorSafe, leg_a: legA, leg_b: legB, block: Number(block) }

  if (!legA.ok && /blacklisted|paused/i.test(legA.reason)) {
    return makeResult(spec, ctx, {
      status: 'fail',
      evidence: `EURC.transfer(${shortAddr(payee)}, ${amt}) from the Safe reverts: "${legA.reason}". Payment stopped before Thyme is asked.`,
      source,
      data,
    })
  }
  // A Roles revert is Thyme being refused; ModuleTransactionFailed while leg (a) already failed is just the inner transfer again.
  if (legB.ran && !legB.ok && !(legB.revert.name === 'ModuleTransactionFailed' && !legA.ok)) {
    const executor = rail.executorSafe ? shortAddr(rail.executorSafe) : 'executor'
    return makeResult(spec, ctx, {
      status: 'fail',
      evidence: `Roles dry-run from executor ${executor} reverts: ${legB.revert.human} (${legB.revert.name}). Thyme would be refused on chain.`,
      source,
      data,
    })
  }
  if (!legA.ok && /exceeds balance/i.test(legA.reason)) {
    return makeResult(spec, ctx, { status: 'warn', evidence: `Safe cannot cover ${amt} right now ("${legA.reason}"); top up, then release.`, source, data })
  }
  if (!legA.ok) {
    return makeResult(spec, ctx, { status: 'warn', evidence: `Dry-run reverted: "${legA.reason}".`, source, data })
  }
  const legBNote = legB.ran
    ? `; Roles dry-run via executor ${shortAddr(rail.executorSafe)} ok (membership + EURC.transfer scope)`
    : '; Roles dry-run skipped (role key not stored)'
  return makeResult(spec, ctx, {
    status: 'pass',
    evidence: `EURC.transfer(${shortAddr(payee)}, ${amt}) from Safe ${shortAddr(safe)} succeeds in simulation (gas ${legA.gas})${legBNote}.`,
    source,
    data,
  })
}

export const transferPreflight: CheckSpec = { ...spec, run }
