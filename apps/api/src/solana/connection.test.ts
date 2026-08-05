import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { Connection } from '@solana/web3.js';
import {
  resolveAllRpcEndpoints,
  resolveRpcUrl,
  resolveWsUrl,
  getConnection,
} from './connection.js';

vi.mock('@solana/web3.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@solana/web3.js')>();
  return {
    ...actual,
    Connection: vi.fn((url: string, opts: unknown) => new actual.Connection(url, opts as never)),
  };
});

describe('resolveAllRpcEndpoints', () => {
  it('puts Helius first (with its wss endpoint) when it is the only provider configured', () => {
    const config = { heliusApiKey: 'key123' };
    const endpoints = resolveAllRpcEndpoints(config);
    expect(endpoints[0]).toEqual({
      label: 'helius',
      url: resolveRpcUrl(config),
      wsUrl: resolveWsUrl(config),
      tier: 'primary',
    });
    expect(endpoints[endpoints.length - 1]).toEqual({
      label: 'public',
      url: 'https://api.mainnet-beta.solana.com',
      tier: 'fallback',
    });
  });

  it('puts Helius first (as primary) with QuickNode as a fallback when both are configured', () => {
    // Helius is primary — see resolveAllRpcEndpoints's doc comment: only the
    // first provider's subscriptions are ever used, so it must be whichever
    // provider is actually reliable for real-time launch detection.
    const config = {
      heliusApiKey: 'key123',
      quicknodeRpcUrl: 'https://quicknode.example.com',
      quicknodeWsUrl: 'wss://quicknode.example.com',
    };
    const endpoints = resolveAllRpcEndpoints(config);
    expect(endpoints[0]).toEqual({
      label: 'helius',
      url: resolveRpcUrl(config),
      wsUrl: resolveWsUrl(config),
      tier: 'primary',
    });
    expect(endpoints[1]).toEqual({
      label: 'quicknode',
      url: 'https://quicknode.example.com',
      wsUrl: 'wss://quicknode.example.com',
      tier: 'primary',
    });
  });

  it('includes the raw configured SOLANA_RPC_URL as a distinct provider alongside Helius', () => {
    // Previously SOLANA_RPC_URL was accepted in config but completely unused
    // whenever a Helius key was set — no failover at all. It's now one more
    // provider in the pool.
    const endpoints = resolveAllRpcEndpoints({
      heliusApiKey: 'key123',
      rpcUrl: 'https://custom-rpc.example.com',
    });
    expect(endpoints.map((e) => e.url)).toContain('https://custom-rpc.example.com');
  });

  it('includes QuickNode, Chainstack, and comma-separated ADDITIONAL_RPC_URLS when configured, Helius first', () => {
    const endpoints = resolveAllRpcEndpoints({
      heliusApiKey: 'key123',
      quicknodeRpcUrl: 'https://quicknode.example.com',
      chainstackRpcUrl: 'https://chainstack.example.com',
      additionalRpcUrls: 'https://a.example.com, https://b.example.com',
    });
    expect(endpoints.map((e) => e.label)).toEqual([
      'helius',
      'quicknode',
      'chainstack',
      'custom-1',
      'custom-2',
      'public',
    ]);
    expect(endpoints.map((e) => e.url)).toContain('https://a.example.com');
    expect(endpoints.map((e) => e.url)).toContain('https://b.example.com');
  });

  it('dedupes by URL, keeping only the first occurrence', () => {
    const endpoints = resolveAllRpcEndpoints({
      rpcUrl: 'https://api.mainnet-beta.solana.com',
    });
    const urls = endpoints.map((e) => e.url);
    expect(urls.filter((u) => u === 'https://api.mainnet-beta.solana.com')).toHaveLength(1);
  });

  it('has just the public endpoint when nothing at all is configured', () => {
    expect(resolveAllRpcEndpoints({})).toEqual([
      { label: 'public', url: 'https://api.mainnet-beta.solana.com', tier: 'fallback' },
    ]);
  });

  it('tags SOLANA_RPC_URL as fallback tier when it points at the same public endpoint (2026-07-15 429 fix)', () => {
    // Exactly the production misconfiguration that caused constant 429s:
    // SOLANA_RPC_URL left pointed at Solana's shared public RPC, which then
    // got round-robined an equal share of traffic its rate limit can't sustain.
    const endpoints = resolveAllRpcEndpoints({
      heliusApiKey: 'key123',
      rpcUrl: 'https://api.mainnet-beta.solana.com',
    });
    const configuredRpc = endpoints.find((e) => e.label === 'configured-rpc');
    expect(configuredRpc?.tier).toBe('fallback');
    const helius = endpoints.find((e) => e.label === 'helius');
    expect(helius?.tier).toBe('primary');
  });

  it('tags SOLANA_RPC_URL as primary tier when it points at a real distinct provider', () => {
    const endpoints = resolveAllRpcEndpoints({
      rpcUrl: 'https://my-dedicated-node.example.com',
    });
    const configuredRpc = endpoints.find((e) => e.label === 'configured-rpc');
    expect(configuredRpc?.tier).toBe('primary');
  });

  it('tags every known shared/free public RPC host as fallback, even via ADDITIONAL_RPC_URLS', () => {
    const knownPublicUrls = [
      'https://rpc.ankr.com/solana',
      'https://solana.drpc.org',
      'https://solana-rpc.publicnode.com',
      'https://solana-mainnet.gateway.tatum.io',
      'https://solana.api.onfinality.io/public',
      'https://solana.api.pocket.network',
    ];
    const endpoints = resolveAllRpcEndpoints({
      heliusApiKey: 'key123',
      additionalRpcUrls: knownPublicUrls.join(','),
    });
    for (const url of knownPublicUrls) {
      expect(endpoints.find((e) => e.url === url)?.tier).toBe('fallback');
    }
    const helius = endpoints.find((e) => e.label === 'helius');
    expect(helius?.tier).toBe('primary');
  });

  it('tags a real dedicated provider passed via ADDITIONAL_RPC_URLS as primary', () => {
    const endpoints = resolveAllRpcEndpoints({
      additionalRpcUrls: 'https://my-dedicated-node.example.com',
    });
    const custom = endpoints.find((e) => e.label === 'custom-1');
    expect(custom?.tier).toBe('primary');
  });
});

describe('getConnection', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.mocked(Connection).mockClear();
  });
  afterEach(() => {
    vi.resetModules();
  });

  it('disables web3.js internal 429 retry on every constructed Connection (2026-07-15 Helius credit audit)', async () => {
    // web3.js's own Connection retries a 429 up to 5x against the same
    // endpoint before resilientConnection.ts's rotate-immediately-on-429
    // logic ever sees the error — this option makes resilientConnection.ts
    // the only retry layer, as its own doc comment already assumes.
    const fresh = await import('./connection.js');
    fresh.getConnection(
      {
        heliusApiKey: 'key123',
        quicknodeRpcUrl: 'https://quicknode.example.com',
      },
      { warn: vi.fn() } as never,
    );
    expect(Connection).toHaveBeenCalled();
    for (const call of vi.mocked(Connection).mock.calls) {
      expect(call[1]).toMatchObject({ disableRetryOnRateLimit: true });
    }
  });
});
