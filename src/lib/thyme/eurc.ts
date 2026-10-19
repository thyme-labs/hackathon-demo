import { type Address, formatUnits, parseUnits } from 'viem'

/** Circle EURC on Ethereum Sepolia (FiatToken proxy, 6 decimals). Public testnet address. */
export const EURC_ADDRESS: Address = '0x08210F9170F89Ab7658F0B5E3fF39b0E03C594D4'
export const EURC_DECIMALS = 6
export const SEPOLIA_CHAIN_ID = 11155111

/** "600.00" | 600 | 600000000n -> 600000000n (base units). Numbers are fixed to 6 dp first to avoid float drift. */
export function toEurcUnits(amount: bigint | number | string): bigint {
  if (typeof amount === 'bigint') return amount
  const text = typeof amount === 'number' ? amount.toFixed(EURC_DECIMALS) : amount.trim()
  return parseUnits(text, EURC_DECIMALS)
}

/** 600000000n -> "600" (human EURC). */
export function formatEurc(units: bigint): string {
  return formatUnits(units, EURC_DECIMALS)
}
