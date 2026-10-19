// Server-only: what registering a beneficiary means now that Thyme is the rail. There is no Safe
// transaction per payee any more: the Roles scope (EURC.transfer from this Safe) was set once at
// onboarding; the per-beneficiary wallet and 30-day limit are enforced by the payment agent.
import { getAddress, isAddress } from 'viem'
import { serverEnv } from '../env'
import { beneficiaries } from '../store/repos'
import type { Beneficiary } from '../store/types'
import type { RegistrationPlan } from './dto'
import { isOnboarded, readOnboardingState } from './thymeOnboarding'

if (typeof window !== 'undefined') {
  throw new Error('src/lib/server/registration.ts is server-only')
}

const eur = (n: number) => `€${n.toLocaleString('en-IE', { maximumFractionDigits: 0 })}`

export async function planRegistration(candidate: Beneficiary, limitEur: number): Promise<RegistrationPlan> {
  if (!candidate.wallet || !isAddress(candidate.wallet)) throw new Error('beneficiary has no valid wallet')
  const wallet = getAddress(candidate.wallet)
  const state = readOnboardingState()
  const executor = serverEnv.paymentExecutor()
  const onboarded = isOnboarded(state)
  const simulated = executor === 'simulated' || (!onboarded && Boolean(state.simulatedAt))
  const ready = onboarded || simulated
  const others = beneficiaries.list('active').filter((b) => b.id !== candidate.id && b.wallet && isAddress(b.wallet))
  const payees = others.length + 1
  const reason = onboarded
    ? `Thyme pays from the Safe ${state.safeAddress ?? ''}; no signature needed for a new payee.`
    : simulated
      ? 'Simulated: no wallet and no Thyme. Payouts will be labelled simulated.'
      : 'Payroll is not enabled on a Safe yet. Enable it first, or continue with a labelled simulation.'
  return {
    ready,
    onboarded,
    simulated,
    executor,
    reason,
    safeAddress: state.safeAddress,
    profileId: state.profileId,
    payees,
    limitEur,
    chain: ['EURC only', 'transfer(address,uint256) only', `from this Safe, only through Thyme${state.rolesProxy ? ` (Roles ${state.rolesProxy.slice(0, 8)}…)` : ''}`, 'gas sponsored by Thyme'],
    agent: [`Pay ${candidate.name} at ${wallet.slice(0, 6)}…${wallet.slice(-4)} only (wallet on file)`, `≤ ${eur(limitEur)} / 30 days for ${candidate.name}`, `${payees} registered payee${payees === 1 ? '' : 's'}; anyone else is refused`, 'Sanctions, country risk, issuer backing and invoice integrity before every payout'],
  }
}
