// Deterministic identifiers for a payroll mandate.
//
// One mandate = one Roles proxy on the Safe + one role key the agent is a member of.
// Allowance keys are global per Roles proxy, so each payee gets its own key derived
// from (roleKey, wallet). The Roles proxy salt is derived from the mandate id, which
// means re-installing with the same mandate id on the same Safe reverts
// (ModuleProxyFactory: TakenAddress). Use a fresh mandate id to install again.
import { type Address, encodePacked, getAddress, type Hex, keccak256, toHex } from 'viem';
import type { PayeeScope } from './conditions';

export const DEFAULT_MANDATE_NAMESPACE = 'thyme-payroll';

export type MandateKeys = {
  mandateId: string;
  roleKey: Hex;
  rolesSalt: bigint;
};

/** Role key + Roles proxy CREATE2 salt for a mandate id (e.g. the Safe address or 'payroll-1'). */
export function mandateKeys(mandateId: string, namespace: string = DEFAULT_MANDATE_NAMESPACE): MandateKeys {
  if (!mandateId) throw new Error('mandateId is required');
  return {
    mandateId,
    roleKey: keccak256(toHex(`${namespace}:role:${mandateId}`)),
    rolesSalt: BigInt(keccak256(toHex(`${namespace}:roles-salt:${mandateId}`))),
  };
}

/** Per-(role, payee) allowance key: keccak256(roleKey ++ wallet). */
export function allowanceKeyFor(roleKey: Hex, wallet: Address): Hex {
  return keccak256(encodePacked(['bytes32', 'address'], [roleKey, getAddress(wallet)]));
}

/** Payee entry for the condition tree. */
export function payeeScope(roleKey: Hex, wallet: Address): PayeeScope {
  const checksummed = getAddress(wallet);
  return { wallet: checksummed, allowanceKey: allowanceKeyFor(roleKey, checksummed) };
}

/** A uint256 salt from any string (for Safe creation salt nonces). */
export function saltFromString(seed: string): bigint {
  return BigInt(keccak256(toHex(seed)));
}
