import { Connection } from '@solana/web3.js';

export interface SolanaConfig {
  rpcUrl?: string;
  wsUrl?: string;
  heliusApiKey?: string;
}

const DEFAULT_PUBLIC_RPC = 'https://api.mainnet-beta.solana.com';

/** Resolves the RPC endpoint, preferring Helius (if a key is configured) over a raw URL. */
export function resolveRpcUrl(config: SolanaConfig): string {
  if (config.heliusApiKey) {
    return `https://mainnet.helius-rpc.com/?api-key=${config.heliusApiKey}`;
  }
  return config.rpcUrl ?? DEFAULT_PUBLIC_RPC;
}

export function resolveWsUrl(config: SolanaConfig): string | undefined {
  if (config.heliusApiKey) {
    return `wss://mainnet.helius-rpc.com/?api-key=${config.heliusApiKey}`;
  }
  return config.wsUrl;
}

let connection: Connection | undefined;

export function getConnection(config: SolanaConfig): Connection {
  if (!connection) {
    connection = new Connection(resolveRpcUrl(config), {
      commitment: 'confirmed',
      wsEndpoint: resolveWsUrl(config),
    });
  }
  return connection;
}
