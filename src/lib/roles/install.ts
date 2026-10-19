// Owner-side batches for the per-payee payroll mandate. Every function is a pure encoder: it returns the
// calls and ONE SafeTx (delegatecall MultiSendCallOnly, or a direct call) that the Safe owner signs
// through Safe.execTransaction (see chain/safe.ts buildExecTransactionCall).
//
// Gas on a Sepolia fork: install N=1 ~526k, add payee ~255k-306k, remove ~221k, revoke ~72k.
import {
  type Address,
  concatHex,
  encodeAbiParameters,
  encodeFunctionData,
  getContractAddress,
  type Hex,
  keccak256,
  pad,
  toHex,
} from 'viem';
import { moduleProxyFactoryAbi, rolesAbi, safeAbi } from './abi';
import type { AllowanceParams } from './allowance';
import { ZERO_ALLOWANCE } from './allowance';
import { buildPerPayeeConditions, ExecutionOptions, type PayeeScope } from './conditions';
import {
  EURC,
  MODULE_PROXY_CREATION_CODE_PREFIX,
  MODULE_PROXY_CREATION_CODE_SUFFIX,
  MODULE_PROXY_FACTORY,
  MULTI_SEND_CALL_ONLY,
  MULTISEND_UNWRAPPER,
  ROLES_MASTERCOPY,
  SEL_MULTISEND,
  SEL_TRANSFER,
} from './constants';
import { type Call, type SafeTx, toMultiSendSafeTx } from './multisend';

/** Roles.setUp(abi.encode(owner, avatar, target)) with all three = the Safe. */
export function rolesInitializer(safe: Address): Hex {
  return encodeFunctionData({
    abi: rolesAbi,
    functionName: 'setUp',
    args: [encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'address' }], [safe, safe, safe])],
  });
}

/** CREATE2 address ModuleProxyFactory 1.2.0 deploys to: salt = keccak256(keccak256(initializer) ++ saltNonce). */
export function predictRolesProxy(safe: Address, rolesSalt: bigint): Address {
  const initializer = rolesInitializer(safe);
  return getContractAddress({
    opcode: 'CREATE2',
    from: MODULE_PROXY_FACTORY,
    salt: keccak256(concatHex([keccak256(initializer), pad(toHex(rolesSalt), { size: 32 })])),
    bytecode: concatHex([
      MODULE_PROXY_CREATION_CODE_PREFIX,
      ROLES_MASTERCOPY.toLowerCase() as Hex,
      MODULE_PROXY_CREATION_CODE_SUFFIX,
    ]),
  });
}

function rolesCall(rolesProxy: Address, data: Hex): Call {
  return { to: rolesProxy, value: 0n, data };
}

export function encodeScopeFunction(roleKey: Hex, payees: readonly PayeeScope[], token: Address = EURC): Hex {
  return encodeFunctionData({
    abi: rolesAbi,
    functionName: 'scopeFunction',
    args: [roleKey, token, SEL_TRANSFER, buildPerPayeeConditions(payees), ExecutionOptions.None],
  });
}

export function encodeSetAllowance(allowanceKey: Hex, a: AllowanceParams): Hex {
  return encodeFunctionData({
    abi: rolesAbi,
    functionName: 'setAllowance',
    args: [allowanceKey, a.balance, a.maxRefill, a.refill, a.period, a.timestamp ?? 0n],
  });
}

export function encodeAssignRole(agent: Address, roleKey: Hex, member: boolean): Hex {
  return encodeFunctionData({ abi: rolesAbi, functionName: 'assignRoles', args: [agent, [roleKey], [member]] });
}

export type InstallParams = {
  safe: Address;
  /** role member: the EOA that calls execTransactionWithRole (our agent signer, or a Thyme profile) */
  agent: Address;
  roleKey: Hex;
  rolesSalt: bigint;
  payee: PayeeScope;
  allowance: AllowanceParams;
  /** default EURC */
  token?: Address;
  /** also register MultiSendUnwrapper so the agent can batch several transfers in one call */
  enableBatching?: boolean;
};

export type InstallBatch = { rolesProxy: Address; calls: Call[]; safeTx: SafeTx };

/**
 * ONE owner Safe tx that installs the module for the FIRST payee:
 * deployModule -> enableModule -> assignRoles(agent) -> scopeTarget(token) -> scopeFunction(N=1) -> setAllowance(key_1).
 */
export function encodeInstallBatch(p: InstallParams): InstallBatch {
  const token = p.token ?? EURC;
  const rolesProxy = predictRolesProxy(p.safe, p.rolesSalt);
  const calls: Call[] = [
    {
      to: MODULE_PROXY_FACTORY,
      value: 0n,
      data: encodeFunctionData({
        abi: moduleProxyFactoryAbi,
        functionName: 'deployModule',
        args: [ROLES_MASTERCOPY, rolesInitializer(p.safe), p.rolesSalt],
      }),
    },
    {
      to: p.safe,
      value: 0n,
      data: encodeFunctionData({ abi: safeAbi, functionName: 'enableModule', args: [rolesProxy] }),
    },
    rolesCall(rolesProxy, encodeAssignRole(p.agent, p.roleKey, true)),
    rolesCall(rolesProxy, encodeFunctionData({ abi: rolesAbi, functionName: 'scopeTarget', args: [p.roleKey, token] })),
    rolesCall(rolesProxy, encodeScopeFunction(p.roleKey, [p.payee], token)),
    rolesCall(rolesProxy, encodeSetAllowance(p.payee.allowanceKey, p.allowance)),
  ];
  if (p.enableBatching) {
    calls.push(
      rolesCall(
        rolesProxy,
        encodeFunctionData({
          abi: rolesAbi,
          functionName: 'setTransactionUnwrapper',
          args: [MULTI_SEND_CALL_ONLY, SEL_MULTISEND, MULTISEND_UNWRAPPER],
        }),
      ),
    );
  }
  return { rolesProxy, calls, safeTx: toMultiSendSafeTx(calls) };
}

export type AddPayeeParams = {
  rolesProxy: Address;
  roleKey: Hex;
  /** existing + new, in branch order (the full list is re-scoped) */
  allPayees: readonly PayeeScope[];
  newPayees: readonly { payee: PayeeScope; allowance: AllowanceParams }[];
  token?: Address;
};

/**
 * ONE owner Safe tx that adds payee(s): scopeFunction with the full new tree + setAllowance for each NEW key.
 * Existing allowances are not touched (scopeFunction only rewrites the condition buffer). Never re-setAllowance
 * an existing key here: it would reset that payee's balance and refill timestamp.
 */
export function encodeAddPayeeBatch(p: AddPayeeParams): { calls: Call[]; safeTx: SafeTx } {
  const all = new Set(p.allPayees.map((x) => x.allowanceKey.toLowerCase()));
  for (const n of p.newPayees) {
    if (!all.has(n.payee.allowanceKey.toLowerCase()))
      throw new Error(`new payee ${n.payee.wallet} is missing from allPayees`);
  }
  const calls: Call[] = [
    rolesCall(p.rolesProxy, encodeScopeFunction(p.roleKey, p.allPayees, p.token)),
    ...p.newPayees.map((n) => rolesCall(p.rolesProxy, encodeSetAllowance(n.payee.allowanceKey, n.allowance))),
  ];
  return { calls, safeTx: toMultiSendSafeTx(calls) };
}

export type RemovePayeeParams = {
  rolesProxy: Address;
  roleKey: Hex;
  /** payees that stay, in branch order; empty list = revoke the function entirely */
  remainingPayees: readonly PayeeScope[];
  removedKeys: readonly Hex[];
  token?: Address;
};

/** Remove payee(s): re-scope without their branches and zero their allowances. */
export function encodeRemovePayeeBatch(p: RemovePayeeParams): { calls: Call[]; safeTx: SafeTx } {
  const token = p.token ?? EURC;
  const scope: Call =
    p.remainingPayees.length === 0
      ? rolesCall(
          p.rolesProxy,
          encodeFunctionData({ abi: rolesAbi, functionName: 'revokeFunction', args: [p.roleKey, token, SEL_TRANSFER] }),
        )
      : rolesCall(p.rolesProxy, encodeScopeFunction(p.roleKey, p.remainingPayees, token));
  const calls: Call[] = [
    scope,
    ...p.removedKeys.map((k) => rolesCall(p.rolesProxy, encodeSetAllowance(k, ZERO_ALLOWANCE))),
  ];
  return { calls, safeTx: toMultiSendSafeTx(calls) };
}

/** Change a payee's monthly limit. Note: setAllowance resets the balance to `allowance.balance` and restarts the period. */
export function encodeUpdateLimitBatch(p: { rolesProxy: Address; allowanceKey: Hex; allowance: AllowanceParams }): {
  calls: Call[];
  safeTx: SafeTx;
} {
  const call = rolesCall(p.rolesProxy, encodeSetAllowance(p.allowanceKey, p.allowance));
  return { calls: [call], safeTx: { ...call, operation: 0 } };
}

/** Kill switch: owner revokes the agent's role membership. Single direct call, no MultiSend. */
export function encodeRevokeBatch(p: { rolesProxy: Address; roleKey: Hex; agent: Address }): {
  calls: Call[];
  safeTx: SafeTx;
} {
  const call = rolesCall(p.rolesProxy, encodeAssignRole(p.agent, p.roleKey, false));
  return { calls: [call], safeTx: { ...call, operation: 0 } };
}

/** Resume: re-assign the role to the agent (same proxy, same limits, no re-install). */
export function encodeResumeBatch(p: { rolesProxy: Address; roleKey: Hex; agent: Address }): {
  calls: Call[];
  safeTx: SafeTx;
} {
  const call = rolesCall(p.rolesProxy, encodeAssignRole(p.agent, p.roleKey, true));
  return { calls: [call], safeTx: { ...call, operation: 0 } };
}

/** Full teardown: revoke the agent and disable the module on the Safe (prevModule from chain/safe.ts findPrevModule). */
export function encodeUninstallBatch(p: {
  safe: Address;
  rolesProxy: Address;
  roleKey: Hex;
  agent: Address;
  prevModule: Address;
}): { calls: Call[]; safeTx: SafeTx } {
  const calls: Call[] = [
    rolesCall(p.rolesProxy, encodeAssignRole(p.agent, p.roleKey, false)),
    {
      to: p.safe,
      value: 0n,
      data: encodeFunctionData({ abi: safeAbi, functionName: 'disableModule', args: [p.prevModule, p.rolesProxy] }),
    },
  ];
  return { calls, safeTx: toMultiSendSafeTx(calls) };
}
