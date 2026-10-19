import { PROOF_MAX_AGE_DAYS, parseOwnershipProof, verifyOwnershipProof } from '../ownership'
import { type CheckContext, type CheckSpec, makeResult } from './context'

const spec = { id: 'ownership_proof', label: 'Wallet ownership proof', enforcement: 'agent', weight: 4 } as const

export const run = async (ctx: CheckContext) => {
  const b = ctx.beneficiary
  const source = 'EIP-712 signature on file (verified with viem, EIP-1271 aware when a client is injected)'
  if (!b) {
    return makeResult(spec, ctx, { status: 'skip', evidence: 'Collected at onboarding; no beneficiary yet.', source })
  }
  if (!b.wallet) {
    return makeResult(spec, ctx, { status: 'warn', evidence: `${b.name} has no wallet on file; nothing to prove yet.`, source, data: { hasProof: false } })
  }
  const wallet = b.wallet
  const proof = parseOwnershipProof(b.ownership_proof_json)
  if (!proof) {
    return makeResult(spec, ctx, {
      status: b.status === 'active' ? 'skip' : 'warn',
      evidence: `No EIP-712 ownership signature on file for ${wallet.slice(0, 6)}…${wallet.slice(-4)}${b.status === 'active' ? '; wallet was approved by the owner at registration' : ''}. Ask the contractor to sign once (Travel Rule proof for off-ramps above €1,000).`,
      source,
      data: { hasProof: false },
    })
  }
  const verdict = await verifyOwnershipProof(proof, wallet, ctx.now, ctx.deps.verifier)
  const data = { hasProof: true, valid: verdict.valid, ageDays: verdict.ageDays, signedAt: proof.signedAt }
  if (!verdict.valid) {
    return makeResult(spec, ctx, { status: 'fail', evidence: `Ownership proof invalid: ${verdict.reason}.`, source, data })
  }
  if (verdict.ageDays !== null && verdict.ageDays > PROOF_MAX_AGE_DAYS) {
    return makeResult(spec, ctx, {
      status: 'warn',
      evidence: `Ownership proof valid but ${verdict.ageDays} days old (limit ${PROOF_MAX_AGE_DAYS}); re-sign.`,
      source,
      data,
    })
  }
  return makeResult(spec, ctx, {
    status: 'pass',
    evidence: `Contractor signed control of ${wallet.slice(0, 6)}…${wallet.slice(-4)} (${verdict.reason}, chain ${proof.chainId}).`,
    source,
    data,
  })
}

export const ownershipProof: CheckSpec = { ...spec, run }
