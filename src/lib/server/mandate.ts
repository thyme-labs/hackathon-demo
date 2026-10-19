// Server-only: builds the ONE Safe transaction the owner signs to register a payee
// (install the Roles module for the first payee, or add a payee to the existing module).
import { type Address, getAddress, type Hex, isAddress, zeroAddress } from 'viem'
import { readMandate } from '../payments/runner'
import { monthlyAllowance } from '../roles/allowance'
import { encodeAddPayeeBatch, encodeInstallBatch, encodeResumeBatch, encodeRevokeBatch } from '../roles/install'
import { mandateKeys, payeeScope } from '../roles/keys'
import type { SafeTx } from '../roles/multisend'
import { parseEurc } from '../roles/units'
import { beneficiaries, settings } from '../store/repos'
import type { Beneficiary } from '../store/types'

if (typeof window !== 'undefined') {
  throw new Error('src/lib/server/mandate.ts is server-only')
}

export type MandatePlanMode = 'install' | 'add_payee' | 'none'

/** Serializable (no bigint) Safe tx for the browser; the client parses `value` back to bigint. */
export interface SafeTxDto {
  to: Address
  value: string
  data: Hex
  operation: 0 | 1
}

export interface MandatePlan {
  mode: MandatePlanMode
  /** False when there is no Safe configured or no agent key: the UI offers a simulated signature only. */
  signable: boolean
  reason: string
  safeAddress: Address | null
  agentAddress: Address | null
  rolesProxy: Address | null
  roleKey: Hex | null
  mandateId: string | null
  safeTx: SafeTxDto | null
  calls: string[]
  can: string[]
  cant: string[]
  payees: { name: string; wallet: Address; limitEur: number }[]
}

const toDto = (tx: SafeTx): SafeTxDto => ({ to: tx.to, value: tx.value.toString(), data: tx.data, operation: tx.operation })

export async function resolveAgentAddress(): Promise<Address | null> {
  const { getAgentAddress } = await import('../chain/agentSigner')
  const fromKey = getAgentAddress()
  if (fromKey) return fromKey
  const stored = settings.get('agentAddress')
  return stored && isAddress(stored) ? getAddress(stored) : null
}

const activePayees = (): Beneficiary[] => beneficiaries.list('active').filter((b) => b.wallet && isAddress(b.wallet))

const eur = (n: number) => `€${n.toLocaleString('en-IE', { maximumFractionDigits: 0 })}`

/** Plan for registering `candidate` (already inserted, status may still be 'new') with `limitEur` per 30 days. */
export async function planRegisterPayee(candidate: Beneficiary, limitEur: number): Promise<MandatePlan> {
  if (!candidate.wallet || !isAddress(candidate.wallet)) throw new Error('beneficiary has no valid wallet')
  const wallet = getAddress(candidate.wallet)
  const mandate = readMandate()
  const agent = await resolveAgentAddress()
  const safe = mandate.safeAddress
  const others = activePayees().filter((b) => b.id !== candidate.id)
  const payees = [...others, candidate].map((b) => ({ name: b.name, wallet: getAddress(b.wallet as string), limitEur: b.id === candidate.id ? limitEur : b.monthly_limit_eur }))
  const can = [`Pay ${payees.length} listed payee${payees.length === 1 ? '' : 's'}`, `≤ ${eur(limitEur)} / 30 days for ${candidate.name}`, 'EURC only']
  const cant = ['Pay anyone else', 'Exceed a limit', 'Change the rules']
  const base = { safeAddress: safe, agentAddress: agent, can, cant, payees }
  const signable = Boolean(safe && agent)
  const reason = !safe ? 'No Safe configured (Settings): the signature is simulated.' : !agent ? 'No agent address (AGENT_PRIVATE_KEY): the signature is simulated.' : 'Owner signs one Safe transaction.'

  if (mandate.rolesProxy && mandate.roleKey) {
    const alreadyListed = others.some((b) => b.wallet?.toLowerCase() === wallet.toLowerCase())
    if (alreadyListed) {
      return { ...base, mode: 'none', signable: false, reason: 'Wallet already in the allowlist.', rolesProxy: mandate.rolesProxy, roleKey: mandate.roleKey, mandateId: mandate.mandateId, safeTx: null, calls: [] }
    }
    const allPayees = payees.map((p) => payeeScope(mandate.roleKey as Hex, p.wallet))
    const scope = payeeScope(mandate.roleKey, wallet)
    const batch = encodeAddPayeeBatch({
      rolesProxy: mandate.rolesProxy,
      roleKey: mandate.roleKey,
      allPayees,
      newPayees: [{ payee: scope, allowance: monthlyAllowance(parseEurc(limitEur)) }],
    })
    return {
      ...base,
      mode: 'add_payee',
      signable,
      reason,
      rolesProxy: mandate.rolesProxy,
      roleKey: mandate.roleKey,
      mandateId: mandate.mandateId,
      safeTx: toDto(batch.safeTx),
      calls: [`Allow ${payees.map((p) => p.name).join(', ')}`, `Set limit ${candidate.name}: ${eur(limitEur)} / 30 days`],
    }
  }

  const mandateId = `${(safe ?? 'demo').toLowerCase()}-${Date.now()}`
  const keys = mandateKeys(mandateId)
  const safeForPlan = safe ?? zeroAddress
  const batch = encodeInstallBatch({
    safe: safeForPlan,
    agent: agent ?? zeroAddress,
    roleKey: keys.roleKey,
    rolesSalt: keys.rolesSalt,
    payee: payeeScope(keys.roleKey, wallet),
    allowance: monthlyAllowance(parseEurc(limitEur)),
  })
  return {
    ...base,
    mode: 'install',
    signable,
    reason,
    rolesProxy: batch.rolesProxy,
    roleKey: keys.roleKey,
    mandateId,
    safeTx: toDto(batch.safeTx),
    calls: ['Deploy Roles module', 'Enable module on the Safe', 'Assign the pay role to the agent', 'Allow EURC', `Allow ${candidate.name}`, `Set limit: ${eur(limitEur)} / 30 days`],
  }
}

/** Kill switch / resume: one direct Roles call (assignRoles) from the owner. */
export async function planAgentMembership(member: boolean): Promise<MandatePlan | null> {
  const mandate = readMandate()
  const agent = await resolveAgentAddress()
  if (!mandate.rolesProxy || !mandate.roleKey || !agent || !mandate.safeAddress) return null
  const p = { rolesProxy: mandate.rolesProxy, roleKey: mandate.roleKey, agent }
  const batch = member ? encodeResumeBatch(p) : encodeRevokeBatch(p)
  return {
    mode: 'none',
    signable: true,
    reason: member ? 'Re-assign the pay role to the agent.' : 'Revoke the agent role membership: nothing can move until resumed.',
    safeAddress: mandate.safeAddress,
    agentAddress: agent,
    rolesProxy: mandate.rolesProxy,
    roleKey: mandate.roleKey,
    mandateId: mandate.mandateId,
    safeTx: toDto(batch.safeTx),
    calls: [member ? 'assignRoles(agent, [role], [true])' : 'assignRoles(agent, [role], [false])'],
    can: [],
    cant: [],
    payees: [],
  }
}
