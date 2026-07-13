import { Connection } from '@solana/web3.js';

/**
 * A minimal, single-endpoint connection for the bot's own low-frequency
 * balance reads (Refresh Balance button) — deliberately not a port of
 * apps/api's multi-provider failover connection (solana/connection.ts +
 * resilientConnection.ts), which exists to keep the trading pipeline's
 * websocket subscriptions alive under provider outages. A wallet balance
 * check is a single request-response RPC call with no subscription and no
 * trading-latency sensitivity, so one endpoint with the bot's own retry (via
 * the underlying @solana/web3.js client) is enough.
 */
export function getBotConnection(env: {
  HELIUS_API_KEY?: string;
  SOLANA_RPC_URL?: string;
}): Connection {
  const url = env.HELIUS_API_KEY
    ? `https://mainnet.helius-rpc.com/?api-key=${env.HELIUS_API_KEY}`
    : (env.SOLANA_RPC_URL ?? 'https://api.mainnet-beta.solana.com');
  return new Connection(url, { commitment: 'confirmed' });
}
