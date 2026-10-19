// Agent-side encoding: what the role member sends to the Roles proxy to pay an invoice.
// rolesProxy.execTransactionWithRole(EURC, 0, transfer(to, amount), Call, roleKey, shouldRevert=true)
import { type Address, encodeFunctionData, getAddress, type Hex } from 'viem';
import { erc20Abi, rolesAbi } from './abi';
import { EURC } from './constants';

export type PayoutCall = { to: Address; data: Hex; value: 0n };

export function encodeErc20Transfer(to: Address, amount: bigint): Hex {
  return encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [getAddress(to), amount] });
}

export function encodeExecTransactionWithRole(p: {
  roleKey: Hex;
  target: Address;
  data: Hex;
  value?: bigint;
  operation?: 0 | 1;
  shouldRevert?: boolean;
}): Hex {
  return encodeFunctionData({
    abi: rolesAbi,
    functionName: 'execTransactionWithRole',
    args: [p.target, p.value ?? 0n, p.data, p.operation ?? 0, p.roleKey, p.shouldRevert ?? true],
  });
}

/** The payout transaction (to = Roles proxy). shouldRevert=true so a rejected payout reverts instead of returning false. */
export function buildPayoutCall(p: {
  rolesProxy: Address;
  roleKey: Hex;
  payee: Address;
  amount: bigint;
  token?: Address;
}): PayoutCall {
  if (p.amount <= 0n) throw new Error('amount must be > 0');
  return {
    to: p.rolesProxy,
    value: 0n,
    data: encodeExecTransactionWithRole({
      roleKey: p.roleKey,
      target: p.token ?? EURC,
      data: encodeErc20Transfer(p.payee, p.amount),
    }),
  };
}
