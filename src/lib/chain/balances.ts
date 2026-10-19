// One multicall for the dashboard: ETH, EURC and USDC balances of an address.
import type { Address, PublicClient } from 'viem';
import { formatEther, formatUnits } from 'viem';
import { sepolia } from 'viem/chains';
import { erc20Abi, multicall3Abi } from '../roles/abi';
import { EURC, EURC_DECIMALS, USDC, USDC_DECIMALS } from '../roles/constants';

export const MULTICALL3: Address = sepolia.contracts.multicall3.address;

export type Balances = {
  address: Address;
  eth: bigint;
  eurc: bigint;
  usdc: bigint;
  formatted: { eth: string; eurc: string; usdc: string };
  blockNumber: bigint;
};

export async function readBalances(client: PublicClient, address: Address): Promise<Balances> {
  const [[eth, eurc, usdc], blockNumber] = await Promise.all([
    client.multicall({
      allowFailure: false,
      multicallAddress: MULTICALL3,
      contracts: [
        { address: MULTICALL3, abi: multicall3Abi, functionName: 'getEthBalance', args: [address] },
        { address: EURC, abi: erc20Abi, functionName: 'balanceOf', args: [address] },
        { address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [address] },
      ],
    }),
    client.getBlockNumber(),
  ]);
  return {
    address,
    eth,
    eurc,
    usdc,
    formatted: {
      eth: formatEther(eth),
      eurc: formatUnits(eurc, EURC_DECIMALS),
      usdc: formatUnits(usdc, USDC_DECIMALS),
    },
    blockNumber,
  };
}

export async function readEurcBalance(client: PublicClient, address: Address): Promise<bigint> {
  return client.readContract({ address: EURC, abi: erc20Abi, functionName: 'balanceOf', args: [address] });
}

/** Balances of several addresses (Safe, agent, payees) in one multicall. */
export async function readEurcBalances(
  client: PublicClient,
  addresses: readonly Address[],
): Promise<Record<Address, bigint>> {
  if (addresses.length === 0) return {};
  const results = await client.multicall({
    allowFailure: false,
    multicallAddress: MULTICALL3,
    contracts: addresses.map((a) => ({
      address: EURC,
      abi: erc20Abi,
      functionName: 'balanceOf' as const,
      args: [a] as const,
    })),
  });
  const out: Record<Address, bigint> = {};
  addresses.forEach((a, i) => {
    out[a] = results[i] ?? 0n;
  });
  return out;
}
