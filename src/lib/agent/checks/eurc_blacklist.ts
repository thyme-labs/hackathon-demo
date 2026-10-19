// EURC issuer blacklist: can the payee wallet (and the Safe) receive EURC at all? Circle can freeze an
// address (Blacklistable) or pause the token; either makes the transfer revert, so the agent reads both
// before Thyme is asked, and compares the issuer admin roles with the snapshot in config/issuers.json.
import { type Address, getAddress } from 'viem'
import issuers from '../../../../config/issuers.json'
import { MULTICALL3 } from '../../chain/balances'
import { EURC } from '../../roles/constants'
import { agentEnv } from '../env'
import { chainClient, EURC_EXT_ABI, offlineSkip, railAddresses, rpcHost, rpcSkip } from './_chain'
import { approvedWallets, type CheckContext, type CheckSpec, makeResult, shortAddr } from './context'

const spec = { id: 'eurc_blacklist', label: 'EURC issuer blacklist', enforcement: 'agent', weight: 8 } as const

interface Candidate {
  /** "on file" (registry), "printed" (invoice, when different) or "Safe" (the paying Safe). */
  role: string
  addr: Address
}

interface AdminSnapshot {
  blacklister: string
  owner: string
  master_minter: string
  as_of: string
}

const ADMIN_FIELDS = ['blacklister', 'owner', 'master_minter'] as const

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

/** Wallets the payout could reach: every approved wallet on file, the printed one when unknown, and the Safe. */
const candidatesFor = (ctx: CheckContext, safe: Address | null): { payees: Candidate[]; safe: Candidate | null } => {
  const seen = new Set<string>()
  const payees: Candidate[] = []
  for (const w of approvedWallets(ctx)) {
    if (seen.has(w.wallet)) continue
    seen.add(w.wallet)
    payees.push({ role: w.isPrimary ? 'on file' : `on file${w.label ? ` (${w.label})` : ''}`, addr: getAddress(w.wallet) })
  }
  const printed = ctx.extracted.payment.wallet
  if (printed && !seen.has(printed)) {
    seen.add(printed)
    payees.push({ role: 'printed', addr: getAddress(printed) })
  }
  const safeCandidate = safe && !seen.has(safe.toLowerCase()) ? { role: 'Safe', addr: safe } : null
  return { payees, safe: safeCandidate }
}

export const run = async (ctx: CheckContext) => {
  const snapshot = issuers.tokens.EURC.sepolia_admin as AdminSnapshot
  const rail = railAddresses(ctx.store)
  const { payees, safe } = candidatesFor(ctx, rail.safe)
  const staticSource = `Circle EURC Sepolia ${shortAddr(EURC)} isBlacklisted/paused/admin; admin snapshot config/issuers.json ${snapshot.as_of}`
  if (payees.length === 0) {
    return makeResult(spec, ctx, { status: 'skip', evidence: 'No wallet to screen yet (new payee without a printed wallet).', source: staticSource })
  }
  if (agentEnv.offline()) return offlineSkip(spec, ctx, 'EURC blacklist and pause state')

  const candidates = safe ? [...payees, safe] : payees
  const client = chainClient()
  let reads: { results: unknown[]; block: bigint }
  try {
    const [results, block] = await Promise.all([
      client.multicall({
        allowFailure: false,
        multicallAddress: MULTICALL3,
        contracts: [
          ...candidates.map((c) => ({ address: EURC, abi: EURC_EXT_ABI, functionName: 'isBlacklisted' as const, args: [c.addr] as const })),
          { address: EURC, abi: EURC_EXT_ABI, functionName: 'paused' as const },
          { address: EURC, abi: EURC_EXT_ABI, functionName: 'blacklister' as const },
          { address: EURC, abi: EURC_EXT_ABI, functionName: 'owner' as const },
          { address: EURC, abi: EURC_EXT_ABI, functionName: 'masterMinter' as const },
        ],
      }),
      client.getBlockNumber(),
    ])
    reads = { results: results as unknown[], block }
  } catch (err) {
    return rpcSkip(spec, ctx, err)
  }

  const flags = reads.results.slice(0, candidates.length) as boolean[]
  const [paused, blacklister, owner, masterMinter] = reads.results.slice(candidates.length) as [boolean, string, string, string]
  const screened = candidates.map((c, i) => ({ role: c.role, addr: c.addr, blacklisted: flags[i] === true }))
  const admin = { blacklister, owner, master_minter: masterMinter }
  const changed = ADMIN_FIELDS.filter((k) => !same(admin[k], snapshot[k]))
  const source = `Circle EURC Sepolia ${shortAddr(EURC)} isBlacklisted/paused/admin via ${rpcHost()} at ${ctx.now.toISOString()}, block ${reads.block}; admin snapshot config/issuers.json ${snapshot.as_of}`
  const data = { screened, paused, admin, admin_changed: changed.length > 0, block: Number(reads.block) }

  if (paused) {
    return makeResult(spec, ctx, { status: 'fail', evidence: 'EURC is paused by the issuer; no transfer can settle until Circle unpauses it.', source, data })
  }
  const hits = screened.filter((s) => s.blacklisted)
  if (hits.length) {
    return makeResult(spec, ctx, {
      status: 'fail',
      evidence: hits
        .map((h) => `Wallet ${h.role} ${h.addr} is on the Circle EURC blacklist (issuer freeze, blacklister ${blacklister}); transfer would revert "Blacklistable: account is blacklisted".`)
        .join(' ')
        .concat(' Payment stopped.'),
      source,
      data,
    })
  }
  if (changed.length) {
    return makeResult(spec, ctx, {
      status: 'warn',
      evidence: `EURC admin roles changed since ${snapshot.as_of}: ${changed.map((k) => `${k} ${snapshot[k]} → ${admin[k]}`).join(', ')}. Confirm with Circle's status page before paying.`,
      source,
      data,
    })
  }
  const payeeList = payees.map((c) => `${shortAddr(c.addr)} (${c.role})`).join(', ')
  const subject = `${payeeList}${safe ? ` and Safe ${shortAddr(safe.addr)}` : ''}`
  return makeResult(spec, ctx, {
    status: 'pass',
    evidence: `${subject} ${candidates.length > 1 ? 'are' : 'is'} not blacklisted; EURC not paused; blacklister/owner/masterMinter unchanged since ${snapshot.as_of}.`,
    source,
    data,
  })
}

export const eurcBlacklist: CheckSpec = { ...spec, run }
