import { describe, expect, it } from 'vitest';
import { resolveAllRpcEndpoints, resolveRpcUrl, resolveWsUrl } from './connection.js';

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
});
