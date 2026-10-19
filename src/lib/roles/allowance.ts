// Read Roles v2.1.1 allowances and apply the on-chain accrual formula off chain, so the agent can
// explain "remaining this month" before it sends anything (the Or root hides the reason on revert).
import type { Address, Hex, PublicClient } from 'viem';
import { rolesAbi } from './abi';
import { MAX_UINT128, MONTH_SECONDS } from './constants';
import { allowanceKeyFor } from './keys';

/** Arguments for Roles.setAllowance. maxRefill = 0 would mean unlimited on chain; monthlyAllowance always sets it. */
export type AllowanceParams = {
  balance: bigint;
  maxRefill: bigint;
  refill: bigint;
  period: bigint;
  /** 0 = block.timestamp at the time setAllowance executes */
  timestamp?: bigint;
};

/** Stored allowance, field order as returned by allowances(key). */
export type AllowanceState = {
  refill: bigint;
  maxRefill: bigint;
  period: bigint;
  balance: bigint;
  timestamp: bigint;
};

export type PayeeBudget = {
  allowanceKey: Hex;
  /** true when the key can ever pay: balance > 0 now, or a periodic refill is configured */
  isSet: boolean;
  /** spendable right now (accrued), EURC base units */
  remaining: bigint;
  /** monthly cap (maxRefill); undefined when the contract treats it as unlimited */
  limit: bigint | undefined;
  /** remaining == limit (nothing spent in this period) */
  full: boolean;
  /** refill per period */
  refill: bigint;
  /** period in seconds (0 = one-time budget) */
  period: bigint;
  /** unix seconds of the current period start (last accrual), as the contract would store it after this call */
  periodStart: bigint;
  /** unix seconds of the next period boundary (when the balance refills), undefined without a period */
  nextRefillAt: bigint | undefined;
  /** block timestamp used for the accrual */
  asOf: bigint;
  raw: AllowanceState;
};

/** Monthly limit: starts full, refills by `limit` up to `limit` every 30 days from the moment it is set. */
export function monthlyAllowance(limit: bigint, period: bigint = MONTH_SECONDS): AllowanceParams {
  if (limit <= 0n) throw new Error('limit must be > 0');
  if (limit > MAX_UINT128) throw new Error('limit exceeds uint128');
  return { balance: limit, maxRefill: limit, refill: limit, period };
}

/** All-zero allowance: what encodeRemovePayeeBatch writes for removed payees. */
export const ZERO_ALLOWANCE: AllowanceParams = { balance: 0n, maxRefill: 0n, refill: 0n, period: 0n };

/**
 * Accrual as implemented by Roles (AllowanceTracker._accruedAllowance):
 * no period or no full period elapsed -> unchanged; else balance += refill * elapsedIntervals, capped at
 * maxRefill (unless balance was already >= maxRefill), timestamp advances by whole periods.
 */
export function accrueAllowance(a: AllowanceState, now: bigint): { balance: bigint; timestamp: bigint } {
  if (a.period === 0n || now <= a.timestamp) return { balance: a.balance, timestamp: a.timestamp };
  const elapsedIntervals = (now - a.timestamp) / a.period;
  if (elapsedIntervals === 0n) return { balance: a.balance, timestamp: a.timestamp };
  const timestamp = a.timestamp + elapsedIntervals * a.period;
  if (a.balance >= a.maxRefill) return { balance: a.balance, timestamp };
  const accrued = a.balance + a.refill * elapsedIntervals;
  return { balance: accrued < a.maxRefill ? accrued : a.maxRefill, timestamp };
}

/**
 * Note: setAllowance stores maxRefill = 0 as uint128.max and timestamp = 0 as block.timestamp, so a "zeroed"
 * allowance (encodeRemovePayeeBatch) reads back as {balance 0, refill 0, period 0, maxRefill max}: isSet = false.
 */
export function toPayeeBudget(allowanceKey: Hex, raw: AllowanceState, now: bigint): PayeeBudget {
  const accrued = accrueAllowance(raw, now);
  const isSet = accrued.balance > 0n || (raw.refill > 0n && raw.period > 0n);
  const unlimited = raw.maxRefill === MAX_UINT128;
  const limit = !isSet ? 0n : unlimited ? undefined : raw.maxRefill;
  const nextRefillAt = isSet && raw.period > 0n ? accrued.timestamp + raw.period : undefined;
  return {
    allowanceKey,
    isSet,
    remaining: accrued.balance,
    limit,
    full: limit !== undefined && accrued.balance >= limit,
    refill: raw.refill,
    period: raw.period,
    periodStart: accrued.timestamp,
    nextRefillAt,
    asOf: now,
    raw,
  };
}

/** Plain snapshot shape for the agent's `budget` check (balance = accrued remaining, seconds as numbers). */
export function toAllowanceSnapshot(budget: PayeeBudget): {
  balance: bigint;
  maxRefill: bigint;
  refill: bigint;
  period: number;
  timestamp: number;
} {
  return {
    balance: budget.remaining,
    maxRefill: budget.raw.maxRefill,
    refill: budget.raw.refill,
    period: Number(budget.raw.period),
    timestamp: Number(budget.periodStart),
  };
}

export async function readAllowance(
  client: PublicClient,
  rolesProxy: Address,
  allowanceKey: Hex,
): Promise<AllowanceState> {
  const [refill, maxRefill, period, balance, timestamp] = await client.readContract({
    address: rolesProxy,
    abi: rolesAbi,
    functionName: 'allowances',
    args: [allowanceKey],
  });
  return { refill, maxRefill, period, balance, timestamp };
}

export type RemainingQuery = {
  rolesProxy: Address;
  roleKey: Hex;
  wallet: Address;
};

/** Remaining monthly budget for a payee wallet under a mandate (accrued to the latest block timestamp). */
export async function remainingFor(client: PublicClient, q: RemainingQuery): Promise<PayeeBudget> {
  const allowanceKey = allowanceKeyFor(q.roleKey, q.wallet);
  const [raw, block] = await Promise.all([
    readAllowance(client, q.rolesProxy, allowanceKey),
    client.getBlock({ blockTag: 'latest' }),
  ]);
  return toPayeeBudget(allowanceKey, raw, block.timestamp);
}

/** Same for an explicit allowance key. */
export async function budgetForKey(client: PublicClient, rolesProxy: Address, allowanceKey: Hex): Promise<PayeeBudget> {
  const [raw, block] = await Promise.all([
    readAllowance(client, rolesProxy, allowanceKey),
    client.getBlock({ blockTag: 'latest' }),
  ]);
  return toPayeeBudget(allowanceKey, raw, block.timestamp);
}

/** Decision helper for the `budget` checklist item. */
export function canSpend(budget: PayeeBudget, amount: bigint): { ok: boolean; shortfall: bigint } {
  const ok = budget.isSet && amount > 0n && amount <= budget.remaining;
  return { ok, shortfall: ok ? 0n : amount - budget.remaining };
}
