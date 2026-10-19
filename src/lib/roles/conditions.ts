// Zodiac Roles v2.1.1 condition tree for ERC20.transfer(address to, uint256 amount), per-payee design.
//
//   [0]            Or (paramType None)                                     parent 0 (root)
//   [1..N]         Calldata Matches                                        parent 0
//   [N+2i-1]       param0 `to`     Static EqualTo(wallet_i)                parent i
//   [N+2i]         param1 `amount` Static WithinAllowance(allowanceKey_i)  parent i
//
// Each payee has its own refilling allowance (monthly limit). Fork-tested: unknown payee and
// over-limit both surface as ConditionViolation(OrViolation) because of the Or root; the agent
// reads allowances off chain (allowance.ts) to explain which one it was.
import { type Address, encodeAbiParameters, getAddress, type Hex, isHex } from 'viem';
import { MAX_PAYEES_PER_ROLE } from './constants';

// Types.sol (v2.1.1)
export const ParameterType = {
  None: 0,
  Static: 1,
  Dynamic: 2,
  Tuple: 3,
  Array: 4,
  Calldata: 5,
  AbiEncoded: 6,
} as const;

export const Operator = {
  Pass: 0,
  And: 1,
  Or: 2,
  Nor: 3,
  Matches: 5,
  ArraySome: 6,
  ArrayEvery: 7,
  ArraySubset: 8,
  EqualToAvatar: 15,
  EqualTo: 16,
  GreaterThan: 17,
  LessThan: 18,
  SignedIntGreaterThan: 19,
  SignedIntLessThan: 20,
  Bitmask: 21,
  Custom: 22,
  WithinAllowance: 28,
  EtherWithinAllowance: 29,
  CallWithinAllowance: 30,
} as const;

export const ExecutionOptions = { None: 0, Send: 1, DelegateCall: 2, Both: 3 } as const;

export type ConditionFlat = {
  parent: number;
  paramType: number;
  operator: number;
  compValue: Hex;
};

export type PayeeScope = {
  wallet: Address;
  allowanceKey: Hex;
};

/** abi.encode(address) as a 32-byte word (EqualTo on a Static parameter). */
export function addressWord(address: Address): Hex {
  return encodeAbiParameters([{ type: 'address' }], [getAddress(address)]);
}

function assertBytes32(value: Hex, label: string): void {
  if (!isHex(value) || value.length !== 66) throw new Error(`${label} must be a 32-byte hex value`);
}

/** Flat BFS condition array for the per-payee transfer scope. */
export function buildPerPayeeConditions(payees: readonly PayeeScope[]): ConditionFlat[] {
  if (payees.length === 0) throw new Error('at least one payee is required');
  if (payees.length > MAX_PAYEES_PER_ROLE) {
    throw new Error(`max ${MAX_PAYEES_PER_ROLE} payees per scoped function (uint8 parent index)`);
  }
  const seen = new Set<string>();
  for (const p of payees) {
    const wallet = getAddress(p.wallet).toLowerCase();
    if (seen.has(wallet)) throw new Error(`duplicate payee wallet ${p.wallet}`);
    seen.add(wallet);
    assertBytes32(p.allowanceKey, `allowanceKey for ${p.wallet}`);
  }
  const out: ConditionFlat[] = [{ parent: 0, paramType: ParameterType.None, operator: Operator.Or, compValue: '0x' }];
  for (let i = 0; i < payees.length; i++) {
    out.push({ parent: 0, paramType: ParameterType.Calldata, operator: Operator.Matches, compValue: '0x' });
  }
  payees.forEach((p, i) => {
    out.push({
      parent: i + 1,
      paramType: ParameterType.Static,
      operator: Operator.EqualTo,
      compValue: addressWord(p.wallet),
    });
    out.push({
      parent: i + 1,
      paramType: ParameterType.Static,
      operator: Operator.WithinAllowance,
      compValue: p.allowanceKey,
    });
  });
  return out;
}

/** Read the payee list back out of a condition array built by buildPerPayeeConditions. */
export function payeesFromConditions(conditions: readonly ConditionFlat[]): PayeeScope[] {
  const root = conditions[0];
  if (!root || root.operator !== Operator.Or) return [];
  const branches = conditions.filter((c, i) => i > 0 && c.parent === 0 && c.operator === Operator.Matches).length;
  const out: PayeeScope[] = [];
  for (let i = 1; i <= branches; i++) {
    const children = conditions.filter((c) => c.parent === i && c.paramType === ParameterType.Static);
    const to = children.find((c) => c.operator === Operator.EqualTo);
    const amount = children.find((c) => c.operator === Operator.WithinAllowance);
    if (!to || !amount) continue;
    out.push({ wallet: getAddress(`0x${to.compValue.slice(26)}`), allowanceKey: amount.compValue });
  }
  return out;
}
