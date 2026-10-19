// EIP-712 wallet-ownership proof signed by the contractor at onboarding (Travel Rule
// support: EBA/GL/2024/11 accepts a signed message as proof of control).
import { verifyTypedData } from 'viem'
import type { TypedDataVerifier } from './types'

export const OWNERSHIP_DOMAIN = { name: 'Thyme Payroll', version: '1', chainId: 11155111 } as const

export const OWNERSHIP_TYPES = {
  OwnershipProof: [
    { name: 'beneficiaryId', type: 'string' },
    { name: 'wallet', type: 'address' },
    { name: 'nonce', type: 'string' },
    { name: 'issuedAt', type: 'string' },
    { name: 'statement', type: 'string' },
  ],
} as const

export const OWNERSHIP_STATEMENT = 'I control this wallet and accept EURC payouts from Thyme Payroll on Ethereum Sepolia.'

export interface OwnershipMessage {
  beneficiaryId: string
  wallet: `0x${string}`
  nonce: string
  issuedAt: string
  statement: string
}

/** Shape stored in beneficiaries.ownership_proof_json. */
export interface OwnershipProof {
  wallet: `0x${string}`
  chainId: number
  signature: `0x${string}`
  signedAt: string
  message: OwnershipMessage
}

export const PROOF_MAX_AGE_DAYS = 183

export const parseOwnershipProof = (json: string | null): OwnershipProof | null => {
  if (!json) return null
  try {
    const p = JSON.parse(json) as Partial<OwnershipProof>
    if (!p.wallet || !p.signature || !p.message?.wallet || !p.message.beneficiaryId) return null
    return p as OwnershipProof
  } catch {
    return null
  }
}

export interface ProofVerdict {
  valid: boolean
  reason: string
  ageDays: number | null
}

export const verifyOwnershipProof = async (
  proof: OwnershipProof,
  expectedWallet: string,
  now: Date,
  verifier?: TypedDataVerifier,
): Promise<ProofVerdict> => {
  const wallet = expectedWallet.toLowerCase()
  if (proof.wallet.toLowerCase() !== wallet || proof.message.wallet.toLowerCase() !== wallet) {
    return { valid: false, reason: `proof is for ${proof.message.wallet}, wallet on file is ${expectedWallet}`, ageDays: null }
  }
  const args = {
    address: proof.wallet,
    domain: OWNERSHIP_DOMAIN,
    types: OWNERSHIP_TYPES,
    primaryType: 'OwnershipProof' as const,
    message: proof.message,
    signature: proof.signature,
  }
  let ok = false
  try {
    ok = verifier
      ? await verifier.verifyTypedData({
          ...args,
          domain: { ...OWNERSHIP_DOMAIN },
          types: { OwnershipProof: [...OWNERSHIP_TYPES.OwnershipProof] },
          message: { ...proof.message },
        })
      : await verifyTypedData(args)
  } catch (error) {
    return { valid: false, reason: `signature check failed: ${error instanceof Error ? error.message : String(error)}`, ageDays: null }
  }
  if (!ok) return { valid: false, reason: 'signature does not recover to the wallet on file', ageDays: null }
  const signedAt = proof.signedAt ?? proof.message.issuedAt
  const ageDays = Math.floor((now.getTime() - new Date(signedAt).getTime()) / 86_400_000)
  return { valid: true, reason: `signed ${signedAt.slice(0, 10)}`, ageDays: Number.isFinite(ageDays) ? ageDays : null }
}
