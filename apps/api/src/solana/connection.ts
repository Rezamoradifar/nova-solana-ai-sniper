import { Connection } from '@solana/web3.js';
import type { Logger } from '@nova/shared';
import { wrapWithMultiProviderFailover, type RpcProviderConfig } from './resilientConnection.js';

export interface SolanaConfig {
  rpcUrl?: string;
  wsUrl?: string;
  heliusApiKey?: string;
  quicknodeRpcUrl?: string;
  chainstackRpcUrl?: string;
  /** Raw comma-separated value, same shape as the ADDITIONAL_RPC_URLS env var. */
  additionalRpcUrls?: string;
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

export interface RpcEndpoint {
  label: string;
  url: string;
}

/**
 * Every configured RPC endpoint, in priority order, deduped by URL — the full
 * pool `wrapWithMultiProviderFailover` load-balances and fails over across.
 * Helius first (if configured — it's the paid, highest-capacity option), then
 * QuickNode/Chainstack/any ADDITIONAL_RPC_URLS if set, then the raw configured
 * SOLANA_RPC_URL, and always ending with the public mainnet-beta endpoint so
 * there is at least one provider even with zero configuration. Every one of
 * these is optional and no-ops gracefully when unset — same pattern as every
 * other optional integration in this codebase.
 */
export function resolveAllRpcEndpoints(config: SolanaConfig): RpcEndpoint[] {
  const candidates: RpcEndpoint[] = [];
  if (config.heliusApiKey) {
    candidates.push({ label: 'helius', url: resolveRpcUrl(config) });
  }
  if (config.quicknodeRpcUrl) {
    candidates.push({ label: 'quicknode', url: config.quicknodeRpcUrl });
  }
  if (config.chainstackRpcUrl) {
    candidates.push({ label: 'chainstack', url: config.chainstackRpcUrl });
  }
  const additional = (config.additionalRpcUrls ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  additional.forEach((url, i) => candidates.push({ label: `custom-${i + 1}`, url }));
  if (config.rpcUrl) {
    candidates.push({ label: 'configured-rpc', url: config.rpcUrl });
  }
  candidates.push({ label: 'public', url: DEFAULT_PUBLIC_RPC });

  const seen = new Set<string>();
  return candidates.filter((c) => {
    if (seen.has(c.url)) return false;
    seen.add(c.url);
    return true;
  });
}

let connection: Connection | undefined;

export function getConnection(config: SolanaConfig, logger?: Logger): Connection {
  if (!connection) {
    const endpoints = resolveAllRpcEndpoints(config);
    const providers: RpcProviderConfig[] = endpoints.map(({ label, url }) => ({
      label,
      connection: new Connection(url, {
        commitment: 'confirmed',
        // Only the primary (first) provider's subscriptions are ever used (see
        // SUBSCRIPTION_METHODS in resilientConnection.ts), so only it needs a
        // real wsEndpoint resolved; the rest are only ever called for ordinary
        // request/response RPC methods.
        wsEndpoint: label === endpoints[0]!.label ? resolveWsUrl(config) : undefined,
      }),
    }));
    connection = logger
      ? wrapWithMultiProviderFailover(providers, logger)
      : providers[0]!.connection;
  }
  return connection;
}
