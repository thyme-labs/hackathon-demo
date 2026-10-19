// Safe & Roles rail: is the Thyme rail still armed on the Safe, and can the Safe cover this payout plus
// the open queue? Reads the Safe's module list, the Roles proxy's avatar/target and the Safe's EURC balance.
import { readEurcBalance } from '../../chain/balances'
import { isContract, isModuleEnabled } from '../../chain/safe'
import { rolesAbi } from '../../roles/abi'
import { agentEnv } from '../env'
import { chainClient, eurcNumber, fmtEurc, offlineSkip, railAddresses, rpcHost, rpcSkip } from './_chain'
import { type CheckContext, type CheckSpec, eur, makeResult, shortAddr } from './context'

const spec = { id: 'safe_roles_health', label: 'Safe & Roles rail', enforcement: 'chain', weight: 6 } as const

const STATIC_SOURCE = 'Safe isModuleEnabled / Roles avatar,target / EURC balanceOf on Sepolia'

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()
const cents = (n: number): number => Math.round(n * 100)
const round2 = (n: number): number => Math.round(n * 100) / 100

interface ChainReads {
  safeHasCode: boolean
  proxyHasCode: boolean
  enabled: boolean
  avatar: string
  target: string
  balance: bigint
  block: bigint
}

export const run = async (ctx: CheckContext) => {
  const rail = railAddresses(ctx.store)
  if (!rail.safe || !rail.rolesProxy) {
    return makeResult(spec, ctx, {
      status: 'skip',
      evidence: 'Thyme rail not onboarded on a Safe yet (simulated payouts); nothing to verify on chain.',
      source: STATIC_SOURCE,
    })
  }
  if (agentEnv.offline()) return offlineSkip(spec, ctx, 'Safe module and balance reads')
  const { safe, rolesProxy } = rail
  const client = chainClient()
  const amountEur = ctx.out.amountEur ?? (ctx.extracted.invoice.currency === 'EUR' ? ctx.extracted.invoice.gross : null)
  // Only money still to leave the Safe counts: pending or submitted rows of any beneficiary, not this invoice's own re-run.
  const open = (ctx.store.listOpenPayouts?.() ?? []).filter((p) => (p.status === 'pending' || p.status === 'submitted') && p.invoice_id !== ctx.invoice.id)
  const openEur = round2(open.reduce((s, p) => s + p.amount_eur, 0))

  let chain: ChainReads
  try {
    const [safeHasCode, proxyHasCode] = await Promise.all([isContract(client, safe), isContract(client, rolesProxy)])
    if (!safeHasCode || !proxyHasCode) {
      chain = { safeHasCode, proxyHasCode, enabled: false, avatar: '', target: '', balance: 0n, block: await client.getBlockNumber() }
    } else {
      const [enabled, avatar, target, balance, block] = await Promise.all([
        isModuleEnabled(client, safe, rolesProxy),
        client.readContract({ address: rolesProxy, abi: rolesAbi, functionName: 'avatar' }),
        client.readContract({ address: rolesProxy, abi: rolesAbi, functionName: 'target' }),
        readEurcBalance(client, safe),
        client.getBlockNumber(),
      ])
      chain = { safeHasCode, proxyHasCode, enabled, avatar, target, balance, block }
    }
  } catch (err) {
    return rpcSkip(spec, ctx, err)
  }

  const balance = eurcNumber(chain.balance)
  const need = amountEur !== null ? round2(amountEur + openEur) : null
  const source = `${STATIC_SOURCE} via ${rpcHost()} at ${ctx.now.toISOString()}, block ${chain.block}`
  const data = {
    safe,
    roles_proxy: rolesProxy,
    executor_safe: rail.executorSafe,
    safe_has_code: chain.safeHasCode,
    proxy_has_code: chain.proxyHasCode,
    module_enabled: chain.enabled,
    avatar: chain.avatar || null,
    target: chain.target || null,
    balance_eurc: balance,
    amount_eur: amountEur,
    open_payouts: { count: open.length, total_eur: openEur },
    need_eur: need,
    block: Number(chain.block),
  }

  if (!chain.safeHasCode) {
    return makeResult(spec, ctx, { status: 'fail', evidence: `Safe ${safe} has no code on Sepolia.`, source, data })
  }
  if (!chain.proxyHasCode) {
    return makeResult(spec, ctx, { status: 'fail', evidence: `Roles proxy ${rolesProxy} has no code on Sepolia; Thyme has nothing to call.`, source, data })
  }
  if (!chain.enabled) {
    return makeResult(spec, ctx, {
      status: 'fail',
      evidence: `Roles module ${shortAddr(rolesProxy)} is not enabled on Safe ${shortAddr(safe)} (owner kill switch / module removed): Thyme cannot move funds; the payout would revert NotAuthorized. No money moves.`,
      source,
      data,
    })
  }
  if (!same(chain.avatar, safe) || !same(chain.target, safe)) {
    return makeResult(spec, ctx, {
      status: 'fail',
      evidence: `Roles proxy ${shortAddr(rolesProxy)} points at avatar ${chain.avatar} / target ${chain.target}, not at the Safe ${safe}.`,
      source,
      data,
    })
  }
  const openNote = `${open.length} open payout${open.length === 1 ? '' : 's'} (${eur(openEur)})`
  if (amountEur !== null && need !== null && cents(balance) < cents(need)) {
    return makeResult(spec, ctx, {
      status: 'warn',
      evidence: `Safe holds ${fmtEurc(chain.balance)} EURC; this payout ${eur(amountEur)} plus ${openNote} need ${eur(need)}. Top up before releasing.`,
      source,
      data,
    })
  }
  return makeResult(spec, ctx, {
    status: 'pass',
    evidence: `Roles ${shortAddr(rolesProxy)} enabled on Safe ${shortAddr(safe)}, avatar/target = Safe; Safe holds ${fmtEurc(chain.balance)} EURC, ${openNote}, this one ${amountEur !== null ? eur(amountEur) : 'unknown (FX failed)'}.`,
    source,
    data,
  })
}

export const safeRolesHealth: CheckSpec = { ...spec, run }
