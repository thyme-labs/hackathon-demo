// Sepolia RPC clients, safe to import from both server functions and the browser bundle.
// Primary endpoint comes from env (never hardcode a private node URL); public endpoints are the fallbacks.
import { createPublicClient, fallback, http, type PublicClient, type Transport } from 'viem';
import { sepolia } from 'viem/chains';
import { EXPLORER_URL } from '../roles/constants';

export const PUBLIC_SEPOLIA_RPCS = ['https://ethereum-sepolia-rpc.publicnode.com', 'https://sepolia.drpc.org'] as const;
export const DEFAULT_SEPOLIA_RPC_URL: string = PUBLIC_SEPOLIA_RPCS[0];

export type SepoliaPublicClient = PublicClient<Transport, typeof sepolia>;

type EnvLike = Record<string, string | undefined>;

function readEnv(name: string): string | undefined {
  if (typeof process !== 'undefined' && process.env) {
    const v = (process.env as EnvLike)[name];
    if (v) return v;
  }
  const meta = import.meta as unknown as { env?: EnvLike };
  const viteValue = meta.env?.[`VITE_${name}`];
  return viteValue || undefined;
}

/** SEPOLIA_RPC_URL on the server, VITE_SEPOLIA_RPC_URL in the browser, else publicnode. */
export function resolveRpcUrl(): string {
  return readEnv('SEPOLIA_RPC_URL') ?? DEFAULT_SEPOLIA_RPC_URL;
}

export type ClientOptions = {
  /** overrides env; e.g. an anvil fork URL in scripts */
  rpcUrl?: string;
  /** add the public endpoints behind the primary one (default true) */
  fallbacks?: boolean;
};

export function createSepoliaTransport(opts: ClientOptions = {}): Transport {
  const primary = opts.rpcUrl ?? resolveRpcUrl();
  const urls = opts.fallbacks === false ? [primary] : [primary, ...PUBLIC_SEPOLIA_RPCS.filter((u) => u !== primary)];
  const [first, ...rest] = urls.map((url) => http(url, { timeout: 20_000, retryCount: 2 }));
  if (!first) throw new Error('no RPC url configured');
  return rest.length === 0 ? first : fallback([first, ...rest], { retryCount: 1 });
}

export function createSepoliaPublicClient(opts: ClientOptions = {}): SepoliaPublicClient {
  return createPublicClient({ chain: sepolia, transport: createSepoliaTransport(opts) });
}

let shared: SepoliaPublicClient | undefined;

/** Process-wide client (server) or module singleton (browser). */
export function getPublicClient(): SepoliaPublicClient {
  if (!shared) shared = createSepoliaPublicClient();
  return shared;
}

export const sepoliaChain = sepolia;

export function explorerTxUrl(hash: string): string {
  return `${EXPLORER_URL}/tx/${hash}`;
}

export function explorerAddressUrl(address: string): string {
  return `${EXPLORER_URL}/address/${address}`;
}
