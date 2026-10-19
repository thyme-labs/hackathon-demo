// EURC amount helpers (6 decimals). Keep money as bigint base units everywhere; format only for display.
import { formatUnits, parseUnits } from 'viem';
import { EURC_DECIMALS } from './constants';

/** '1500' | '1500.25' | 1500 -> 1500000000n (EURC base units). Rejects negatives and more than 6 decimals. */
export function parseEurc(amount: string | number): bigint {
  const text = typeof amount === 'number' ? amount.toFixed(EURC_DECIMALS) : amount.trim().replace(',', '.');
  if (!/^\d+(\.\d{1,6})?$/.test(text)) throw new Error(`invalid EURC amount: ${amount}`);
  return parseUnits(text, EURC_DECIMALS);
}

/** 1500000000n -> '1500.00' (always two decimals, more only when needed). */
export function formatEurc(units: bigint, minFraction = 2): string {
  const raw = formatUnits(units, EURC_DECIMALS);
  const [whole = '0', frac = ''] = raw.split('.');
  const trimmed = frac.replace(/0+$/, '');
  const fraction = trimmed.length < minFraction ? trimmed.padEnd(minFraction, '0') : trimmed;
  return fraction ? `${whole}.${fraction}` : whole;
}

/** Display number (e.g. for charts); loses precision above 2^53 base units, fine for payroll sizes. */
export function eurcToNumber(units: bigint): number {
  return Number(units) / 10 ** EURC_DECIMALS;
}
