import { Connection } from '@solana/web3.js';
import type { Logger } from '@nova/shared';
import { wrapWithMultiProviderFailover, type RpcProviderConfig } from './resilientConnection.js';

export interface SolanaConfig {
  rpcUrl?: string;
  wsUrl?: string;
  heliusApiKey?: string;
  quicknodeRpcUrl?: string;
  /** QuickNode's WSS endpoint — same host as quicknodeRpcUrl, used for subscriptions when QuickNode is primary. */
  quicknodeWsUrl?: string;
  chainstackRpcUrl?: string;
  /** Raw comma-separated value, same shape as the ADDITIONAL_RPC_URLS env var. */
  additionalRpcUrls?: string;
}

const DEFAULT_PUBLIC_RPC = 'https://api.mainnet-beta.solana.com';

/**
 * Hostnames of known shared/free public Solana RPC endpoints — same
 * far-lower-rate-limit risk as DEFAULT_PUBLIC_RPC (see tierFor's doc comment
 * below), so a URL on any of these hosts is tagged 'fallback' no matter which
 * env var it arrived through (e.g. ADDITIONAL_RPC_URLS), not only the one
 * literal default URL.
 */
const KNOWN_PUBLIC_RPC_HOSTS = new Set([
  'api.mainnet-beta.solana.com',
  'rpc.ankr.com',
  'solana.drpc.org',
  'solana-rpc.publicnode.com',
  'solana-mainnet.gateway.tatum.io',
  'solana.api.onfinality.io',
  'solana.api.pocket.network',
]);

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
  /** Only meaningful for the primary (first) endpoint — see getConnection. */
  wsUrl?: string;
  /** See RpcProviderConfig.tier's doc comment in resilientConnection.ts. */
  tier: 'primary' | 'fallback';
}

/**
 * Every configured RPC endpoint, in priority order, deduped by URL — the full
 * pool `wrapWithMultiProviderFailover` load-balances and fails over across.
 * Helius first (if configured), then QuickNode (if configured) as a fallback,
 * then Chainstack/any ADDITIONAL_RPC_URLS if set, then the raw configured
 * SOLANA_RPC_URL, and always ending with the public mainnet-beta endpoint so
 * there is at least one provider even with zero configuration. Every one of
 * these is optional and no-ops gracefully when unset — same pattern as every
 * other optional integration in this codebase.
 *
 * Helius is primary rather than QuickNode (reversed from this pool's original
 * priority, see git history) because only the first-listed provider's
 * subscriptions are ever used (see SUBSCRIPTION_METHODS in
 * resilientConnection.ts — subscriptions can't rotate across providers
 * without duplicating or orphaning them), so whichever provider is first
 * silently owns 100% of real-time launch detection with zero failover if it
 * degrades. Confirmed live 2026-07-11: QuickNode's plan hit its daily request
 * limit and its WSS started rejecting every subscribe with the same "request
 * limit reached" error and closing the socket (code 1001) — since it was
 * primary at the time, this didn't just degrade ordinary RPC calls (those
 * still failed over fine), it silently killed launch detection entirely,
 * with zero events reaching any scanner, for hours. Helius was upgraded the
 * same day specifically to take over as the reliable primary.
 *
 * Every candidate whose URL resolves to one of the known shared/free public
 * RPC hosts (`KNOWN_PUBLIC_RPC_HOSTS` — including SOLANA_RPC_URL or any
 * ADDITIONAL_RPC_URLS entry a deployment points at one of these instead of a
 * real dedicated provider, which is exactly what happened in production
 * 2026-07-15 with DEFAULT_PUBLIC_RPC: it was byte-for-byte identical to
 * SOLANA_RPC_URL, so wrapWithMultiProviderFailover's round-robin gave it an
 * equal ~1/3 share of ALL ordinary RPC traffic, and its rate limit — far
 * lower than a paid provider's — couldn't sustain that share, producing
 * constant 429s) is tagged `tier: 'fallback'` rather than `'primary'`, so it's
 * only ever reached once every paid/dedicated provider is unhealthy. If a URL
 * points at a real distinct paid endpoint instead, it correctly gets
 * `'primary'` — the tier follows the URL's host, not the label or env var.
 */
export function resolveAllRpcEndpoints(config: SolanaConfig): RpcEndpoint[] {
  const tierFor = (url: string): 'primary' | 'fallback' => {
    try {
      return KNOWN_PUBLIC_RPC_HOSTS.has(new URL(url).hostname) ? 'fallback' : 'primary';
    } catch {
      return 'primary';
    }
  };

  const candidates: RpcEndpoint[] = [];
  if (config.heliusApiKey) {
    const url = resolveRpcUrl(config);
    candidates.push({ label: 'helius', url, wsUrl: resolveWsUrl(config), tier: tierFor(url) });
  }
  if (config.quicknodeRpcUrl) {
    candidates.push({
      label: 'quicknode',
      url: config.quicknodeRpcUrl,
      wsUrl: config.quicknodeWsUrl,
      tier: tierFor(config.quicknodeRpcUrl),
    });
  }
  if (config.chainstackRpcUrl) {
    candidates.push({
      label: 'chainstack',
      url: config.chainstackRpcUrl,
      tier: tierFor(config.chainstackRpcUrl),
    });
  }
  const additional = (config.additionalRpcUrls ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  additional.forEach((url, i) =>
    candidates.push({ label: `custom-${i + 1}`, url, tier: tierFor(url) }),
  );
  if (config.rpcUrl) {
    candidates.push({
      label: 'configured-rpc',
      url: config.rpcUrl,
      wsUrl: config.wsUrl,
      tier: tierFor(config.rpcUrl),
    });
  }
  candidates.push({ label: 'public', url: DEFAULT_PUBLIC_RPC, tier: 'fallback' });

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
    const providers: RpcProviderConfig[] = endpoints.map((endpoint) => ({
      label: endpoint.label,
      tier: endpoint.tier,
      connection: new Connection(endpoint.url, {
        commitment: 'confirmed',
        // Only the primary (first) provider's subscriptions are ever used (see
        // SUBSCRIPTION_METHODS in resilientConnection.ts), so only it needs a
        // real wsEndpoint resolved; the rest are only ever called for ordinary
        // request/response RPC methods.
        wsEndpoint: endpoint === endpoints[0] ? endpoint.wsUrl : undefined,
        // 2026-07-15 Helius credit audit: web3.js's own Connection has a built-in
        // retry-on-429 loop (up to 5 attempts against the SAME endpoint, 500ms
        // doubling to 8s, no jitter) that runs BEFORE resilientConnection.ts's own
        // rotate-immediately-on-429 logic ever sees the error — so a rate-limited
        // provider was getting hammered up to 5 more times by web3.js, then
        // ALSO retried/rotated by resilientConnection.ts on top. Disabling it here
        // makes resilientConnection.ts's own bounded retry+rotation the only retry
        // layer, exactly as its module doc comment already assumes.
        disableRetryOnRateLimit: true,
      }),
    }));
    connection = logger
      ? wrapWithMultiProviderFailover(providers, logger, {
          // Stage 2 (2026-07-14): only meaningfully active with 2+ providers
          // (resolveAllRpcEndpoints always includes the public fallback, so
          // this is realistically always true in production) — see
          // resilientConnection.ts's ResilientConnectionOptions doc comment.
          benchmarkIntervalMs: 20_000,
        })
      : providers[0]!.connection;
  }
  return connection;
}
