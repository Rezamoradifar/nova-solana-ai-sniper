import { describe, expect, it, vi } from 'vitest';
import { wrapWithMultiProviderFailover, type RpcProviderConfig } from './resilientConnection.js';

function fakeLogger() {
  return { warn: vi.fn() };
}

function provider(label: string, impl: Record<string, unknown>): RpcProviderConfig {
  return { label, connection: impl as never };
}

describe('wrapWithMultiProviderFailover', () => {
  it('passes through a successful call with no retry and no rotation', async () => {
    const primary = { getBalance: vi.fn().mockResolvedValue(42) };
    const secondary = { getBalance: vi.fn() };
    const wrapped = wrapWithMultiProviderFailover(
      [provider('primary', primary), provider('secondary', secondary)],
      fakeLogger(),
    );

    const result = await (wrapped as unknown as typeof primary).getBalance('pubkey');

    expect(result).toBe(42);
    expect(primary.getBalance).toHaveBeenCalledTimes(1);
    expect(secondary.getBalance).not.toHaveBeenCalled();
  });

  it('retries once against the same provider on a retryable error, then succeeds', async () => {
    const primary = {
      getBalance: vi
        .fn()
        .mockRejectedValueOnce(new Error('429 Too Many Requests'))
        .mockResolvedValueOnce(7),
    };
    const secondary = { getBalance: vi.fn() };
    const wrapped = wrapWithMultiProviderFailover(
      [provider('primary', primary), provider('secondary', secondary)],
      fakeLogger(),
      { retryDelayMs: 0 },
    );

    const result = await (wrapped as unknown as typeof primary).getBalance('pubkey');

    expect(result).toBe(7);
    expect(primary.getBalance).toHaveBeenCalledTimes(2);
    expect(secondary.getBalance).not.toHaveBeenCalled();
  });

  it('regression: rotates to the next provider when the first keeps failing with a retryable error', async () => {
    // The concrete production gap being fixed: a Helius rate-limit/outage
    // previously failed the call outright with zero fallback, dropping launch
    // events ("failed to process launch event" — confirmed in live logs).
    const primary = { getSlot: vi.fn().mockRejectedValue(new Error('rate limited')) };
    const secondary = { getSlot: vi.fn().mockResolvedValue(123456) };
    const wrapped = wrapWithMultiProviderFailover(
      [provider('primary', primary), provider('secondary', secondary)],
      fakeLogger(),
      { retryDelayMs: 0 },
    );

    const result = await (wrapped as unknown as typeof primary).getSlot();

    expect(result).toBe(123456);
    expect(primary.getSlot).toHaveBeenCalledTimes(2); // original + one same-provider retry
    expect(secondary.getSlot).toHaveBeenCalledTimes(1);
  });

  it('rotates across three providers, trying each once it has failed twice', async () => {
    const helius = { getSlot: vi.fn().mockRejectedValue(new Error('429 max usage reached')) };
    const quicknode = { getSlot: vi.fn().mockRejectedValue(new Error('503 Service Unavailable')) };
    const publicRpc = { getSlot: vi.fn().mockResolvedValue(999) };
    const wrapped = wrapWithMultiProviderFailover(
      [provider('helius', helius), provider('quicknode', quicknode), provider('public', publicRpc)],
      fakeLogger(),
      { retryDelayMs: 0 },
    );

    const result = await (wrapped as unknown as typeof helius).getSlot();

    expect(result).toBe(999);
    expect(helius.getSlot).toHaveBeenCalledTimes(2);
    expect(quicknode.getSlot).toHaveBeenCalledTimes(2);
    expect(publicRpc.getSlot).toHaveBeenCalledTimes(1);
  });

  it('throws immediately on a non-retryable error — no retry, no rotation', async () => {
    const primary = { getMint: vi.fn().mockRejectedValue(new Error('Invalid public key input')) };
    const secondary = { getMint: vi.fn() };
    const wrapped = wrapWithMultiProviderFailover(
      [provider('primary', primary), provider('secondary', secondary)],
      fakeLogger(),
    );

    await expect((wrapped as unknown as typeof primary).getMint('bad')).rejects.toThrow(
      /Invalid public key/,
    );
    expect(primary.getMint).toHaveBeenCalledTimes(1);
    expect(secondary.getMint).not.toHaveBeenCalled();
  });

  it('throws the last error once every provider has been exhausted', async () => {
    const primary = { getBalance: vi.fn().mockRejectedValue(new Error('timeout')) };
    const secondary = { getBalance: vi.fn().mockRejectedValue(new Error('502 Bad Gateway')) };
    const wrapped = wrapWithMultiProviderFailover(
      [provider('primary', primary), provider('secondary', secondary)],
      fakeLogger(),
      { retryDelayMs: 0 },
    );

    await expect((wrapped as unknown as typeof primary).getBalance('x')).rejects.toThrow(
      /502 Bad Gateway/,
    );
    expect(primary.getBalance).toHaveBeenCalledTimes(2);
    expect(secondary.getBalance).toHaveBeenCalledTimes(2);
  });

  it('throws the retry error when only one provider is configured', async () => {
    const primary = { getBalance: vi.fn().mockRejectedValue(new Error('ETIMEDOUT')) };
    const wrapped = wrapWithMultiProviderFailover([provider('primary', primary)], fakeLogger(), {
      retryDelayMs: 0,
    });

    await expect((wrapped as unknown as typeof primary).getBalance('x')).rejects.toThrow(
      /ETIMEDOUT/,
    );
    expect(primary.getBalance).toHaveBeenCalledTimes(2);
  });

  it('a provider on cooldown after repeated failures is skipped by the next call', async () => {
    const flaky = { getSlot: vi.fn().mockRejectedValue(new Error('429 too many requests')) };
    const reliable = { getSlot: vi.fn().mockResolvedValue(1) };
    const wrapped = wrapWithMultiProviderFailover(
      [provider('flaky', flaky), provider('reliable', reliable)],
      fakeLogger(),
      { retryDelayMs: 0, baseBackoffMs: 60_000 },
    );

    await (wrapped as unknown as typeof flaky).getSlot();
    flaky.getSlot.mockClear();
    reliable.getSlot.mockClear();

    // Second call: `flaky` is now on a long cooldown, so it should be skipped
    // entirely rather than retried — the whole point of backing off a provider
    // that's already known to be failing.
    await (wrapped as unknown as typeof flaky).getSlot();
    expect(flaky.getSlot).not.toHaveBeenCalled();
    expect(reliable.getSlot).toHaveBeenCalledTimes(1);
  });

  it('round-robins across healthy providers instead of always hitting the first one', async () => {
    const a = { getSlot: vi.fn().mockResolvedValue(1) };
    const b = { getSlot: vi.fn().mockResolvedValue(2) };
    const wrapped = wrapWithMultiProviderFailover(
      [provider('a', a), provider('b', b)],
      fakeLogger(),
    );

    await (wrapped as unknown as typeof a).getSlot();
    await (wrapped as unknown as typeof a).getSlot();
    await (wrapped as unknown as typeof a).getSlot();

    // Load balancing: normal (non-error) traffic is spread across providers,
    // not pinned to whichever is listed first.
    expect(a.getSlot.mock.calls.length).toBeGreaterThan(0);
    expect(b.getSlot.mock.calls.length).toBeGreaterThan(0);
  });

  it('de-dupes concurrent identical calls to a cacheable method into one real request', async () => {
    let resolveCall: (v: unknown) => void;
    const pending = new Promise((resolve) => {
      resolveCall = resolve;
    });
    const primary = { getAccountInfo: vi.fn().mockReturnValue(pending) };
    const wrapped = wrapWithMultiProviderFailover([provider('primary', primary)], fakeLogger());

    const call1 = (wrapped as unknown as typeof primary).getAccountInfo('mintA');
    const call2 = (wrapped as unknown as typeof primary).getAccountInfo('mintA');
    resolveCall!('account-data');

    await expect(call1).resolves.toBe('account-data');
    await expect(call2).resolves.toBe('account-data');
    expect(primary.getAccountInfo).toHaveBeenCalledTimes(1);
  });

  it('caches a cacheable method result briefly, then re-fetches after the TTL expires', async () => {
    vi.useFakeTimers();
    try {
      const primary = {
        getAccountInfo: vi.fn().mockResolvedValueOnce('first').mockResolvedValueOnce('second'),
      };
      const wrapped = wrapWithMultiProviderFailover([provider('primary', primary)], fakeLogger(), {
        cacheTtlMs: 1_000,
      });

      const first = await (wrapped as unknown as typeof primary).getAccountInfo('mintA');
      expect(first).toBe('first');

      const stillCached = await (wrapped as unknown as typeof primary).getAccountInfo('mintA');
      expect(stillCached).toBe('first');
      expect(primary.getAccountInfo).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(1_001);

      const afterTtl = await (wrapped as unknown as typeof primary).getAccountInfo('mintA');
      expect(afterTtl).toBe('second');
      expect(primary.getAccountInfo).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never caches a method outside the cacheable safelist (e.g. getBalance)', async () => {
    const primary = { getBalance: vi.fn().mockResolvedValue(1) };
    const wrapped = wrapWithMultiProviderFailover([provider('primary', primary)], fakeLogger());

    await (wrapped as unknown as typeof primary).getBalance('walletX');
    await (wrapped as unknown as typeof primary).getBalance('walletX');

    expect(primary.getBalance).toHaveBeenCalledTimes(2);
  });

  it('passes subscription methods straight through to the first provider only, calling them exactly once', () => {
    // Subscription methods (onLogs, onAccountChange, ...) return a numeric
    // subscription id synchronously — must never be retried/redirected/rotated,
    // that would silently duplicate or break the caller's subscription.
    const primary = { onLogs: vi.fn().mockReturnValue(99) };
    const secondary = { onLogs: vi.fn() };
    const wrapped = wrapWithMultiProviderFailover(
      [provider('primary', primary), provider('secondary', secondary)],
      fakeLogger(),
    );

    const subId = (wrapped as unknown as typeof primary).onLogs('filter', () => {});

    expect(subId).toBe(99);
    expect(primary.onLogs).toHaveBeenCalledTimes(1);
    expect(secondary.onLogs).not.toHaveBeenCalled();
  });

  it('passes non-function properties straight through unchanged', () => {
    const primary = { rpcEndpoint: 'https://example.com' };
    const wrapped = wrapWithMultiProviderFailover([provider('primary', primary)], fakeLogger());

    expect((wrapped as unknown as typeof primary).rpcEndpoint).toBe('https://example.com');
  });

  it('calls the underlying method with the real connection object as `this`, not the proxy', async () => {
    // Guards against a real failure mode with @solana/web3.js's Connection class,
    // which relies on private (#) fields internally — invoking a method with the
    // Proxy itself as the receiver would throw "Cannot read private member"
    // instead of the real result.
    class HasPrivateState {
      #secret = 'ok';
      async readSecret() {
        return this.#secret;
      }
    }
    const primary = new HasPrivateState();
    const wrapped = wrapWithMultiProviderFailover(
      [provider('primary', primary as never)],
      fakeLogger(),
    );

    await expect((wrapped as unknown as HasPrivateState).readSecret()).resolves.toBe('ok');
  });

  it('throws when constructed with zero providers', () => {
    expect(() => wrapWithMultiProviderFailover([], fakeLogger())).toThrow(/at least one provider/);
  });
});
