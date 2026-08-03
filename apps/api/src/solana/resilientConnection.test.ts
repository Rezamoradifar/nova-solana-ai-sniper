import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  wrapWithMultiProviderFailover,
  rpcLatencyRegistry,
  rpcRequestCounters,
  rpcCooldownRegistry,
  type RpcProviderConfig,
} from './resilientConnection.js';

function fakeLogger() {
  return { warn: vi.fn() };
}

function provider(
  label: string,
  impl: Record<string, unknown>,
  tier?: 'primary' | 'fallback',
): RpcProviderConfig {
  return { label, connection: impl as never, tier };
}

beforeEach(() => {
  rpcLatencyRegistry.reset();
  rpcRequestCounters.reset();
  rpcCooldownRegistry.reset();
});

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
    // Non-rate-limit retryable error (a plain network timeout) — 429s get a
    // dedicated fast-rotate path instead, see the "rate-limit fast-rotate"
    // describe block below.
    const primary = {
      getBalance: vi.fn().mockRejectedValueOnce(new Error('ETIMEDOUT')).mockResolvedValueOnce(7),
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
    // The concrete production gap being fixed: a Helius outage previously
    // failed the call outright with zero fallback, dropping launch events
    // ("failed to process launch event" — confirmed in live logs). Uses a
    // non-rate-limit error (429s get a dedicated fast-rotate path instead).
    const primary = { getSlot: vi.fn().mockRejectedValue(new Error('ECONNRESET')) };
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
    // Non-rate-limit errors (429s get a dedicated fast-rotate path instead,
    // tested separately below).
    const helius = { getSlot: vi.fn().mockRejectedValue(new Error('502 Bad Gateway')) };
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

  it('jitters a provider cooldown to within ±20% of the computed backoff (2026-07-15 Helius credit audit)', async () => {
    // Pure exponential backoff with no jitter means every caller that failed
    // at the same moment retries in lockstep — jitter spreads that out. The
    // logged cooldownUntil is the only externally observable readout of the
    // jittered backoff value (backoffFor/withJitter are module-private).
    const flaky = { getSlot: vi.fn().mockRejectedValue(new Error('429 too many requests')) };
    const logger = fakeLogger();
    const wrapped = wrapWithMultiProviderFailover([provider('flaky', flaky)], logger, {
      retryDelayMs: 0,
      baseBackoffMs: 60_000,
      maxBackoffMs: 1_000_000, // high enough that the default 30s cap doesn't clip the value under test
    });

    const before = Date.now();
    await expect((wrapped as unknown as typeof flaky).getSlot()).rejects.toThrow();
    const after = Date.now();

    const [warnArg] = logger.warn.mock.calls[0]!;
    const cooldownDelay = (warnArg as { cooldownUntil: number }).cooldownUntil - before;
    // baseBackoffMs(60_000) * 2^1 = 120_000, jittered to 0.8x-1.2x => [96_000, 144_000],
    // plus the small real wall-clock slack between `before` and when cooldownUntil
    // was actually computed (bounded by `after - before`).
    expect(cooldownDelay).toBeGreaterThanOrEqual(96_000);
    expect(cooldownDelay).toBeLessThanOrEqual(144_000 + (after - before));
  });

  it('applies jitter within a bounded range rather than a fixed multiple of the base delay', async () => {
    const randomSpy = vi.spyOn(Math, 'random');
    const flaky = { getSlot: vi.fn().mockRejectedValue(new Error('429 too many requests')) };
    const logger = fakeLogger();

    for (const rand of [0, 0.5, 1]) {
      randomSpy.mockReturnValue(rand);
      logger.warn.mockClear();
      const wrapped = wrapWithMultiProviderFailover([provider('flaky', flaky)], logger, {
        retryDelayMs: 0,
        baseBackoffMs: 1_000,
      });
      const before = Date.now();
      await expect((wrapped as unknown as typeof flaky).getSlot()).rejects.toThrow();
      const [warnArg] = logger.warn.mock.calls[0]!;
      const cooldownDelay = (warnArg as { cooldownUntil: number }).cooldownUntil - before;
      // baseBackoffMs(1000) * 2^1 = 2000, factor = 0.8 + rand*0.4 => [0.8, 1.2]
      expect(cooldownDelay).toBeGreaterThanOrEqual(2000 * 0.8 - 5);
      expect(cooldownDelay).toBeLessThanOrEqual(2000 * 1.2 + 5);
    }

    randomSpy.mockRestore();
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

  it('dedupes concurrent getParsedTransaction calls for the same signature (2026-07-15 Helius credit audit)', async () => {
    // Real production gap this closes: worker.ts's migration-hint path and
    // its DEX pool-creation path can both fetch the same signature within
    // the same event tick.
    let resolveCall: (v: unknown) => void;
    const pending = new Promise((resolve) => {
      resolveCall = resolve;
    });
    const primary = { getParsedTransaction: vi.fn().mockReturnValue(pending) };
    const wrapped = wrapWithMultiProviderFailover([provider('primary', primary)], fakeLogger());

    const call1 = (wrapped as unknown as typeof primary).getParsedTransaction('sig1');
    const call2 = (wrapped as unknown as typeof primary).getParsedTransaction('sig1');
    resolveCall!({ meta: {} });

    await expect(call1).resolves.toEqual({ meta: {} });
    await expect(call2).resolves.toEqual({ meta: {} });
    expect(primary.getParsedTransaction).toHaveBeenCalledTimes(1);
  });

  it('never caches a null getParsedTransaction result — a not-yet-visible tx must be retried fresh, not served stale null', async () => {
    // Guards positionManager.ts's withVerificationRetry, which retries
    // getParsedTransaction up to 3x, 2000ms apart, specifically because a
    // transaction can transiently resolve null before it's visible yet.
    // Caching that null for cacheTtlMs would silently defeat that retry and
    // reintroduce the wallet-lock bug it was built to fix.
    const primary = {
      getParsedTransaction: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ meta: {} }),
    };
    const wrapped = wrapWithMultiProviderFailover([provider('primary', primary)], fakeLogger());

    const first = await (wrapped as unknown as typeof primary).getParsedTransaction('sig1');
    expect(first).toBeNull();

    const second = await (wrapped as unknown as typeof primary).getParsedTransaction('sig1');
    expect(second).toEqual({ meta: {} });
    expect(primary.getParsedTransaction).toHaveBeenCalledTimes(2);
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

describe('wrapWithMultiProviderFailover — provider tiers (2026-07-15 429 fix)', () => {
  it('never reaches a fallback-tier provider while a primary-tier provider is healthy', async () => {
    const primaryImpl = { getSlot: vi.fn().mockResolvedValue(1) };
    const fallbackImpl = { getSlot: vi.fn().mockResolvedValue(2) };
    const wrapped = wrapWithMultiProviderFailover(
      [provider('primary', primaryImpl, 'primary'), provider('fallback', fallbackImpl, 'fallback')],
      fakeLogger(),
    );

    for (let i = 0; i < 5; i++) {
      await (wrapped as unknown as typeof primaryImpl).getSlot();
    }

    expect(primaryImpl.getSlot).toHaveBeenCalledTimes(5);
    expect(fallbackImpl.getSlot).not.toHaveBeenCalled();
  });

  it('falls through to the fallback tier only once every primary provider is on cooldown', async () => {
    const primaryImpl = {
      getSlot: vi.fn().mockRejectedValue(new Error('timeout')),
    };
    const fallbackImpl = { getSlot: vi.fn().mockResolvedValue(42) };
    const wrapped = wrapWithMultiProviderFailover(
      [provider('primary', primaryImpl, 'primary'), provider('fallback', fallbackImpl, 'fallback')],
      fakeLogger(),
      { retryDelayMs: 0 },
    );

    await expect((wrapped as unknown as typeof primaryImpl).getSlot()).resolves.toBe(42);
    expect(fallbackImpl.getSlot).toHaveBeenCalledTimes(1);
  });

  it('a provider with no tier set defaults to primary (existing callers/tests unaffected)', async () => {
    const impl = { getSlot: vi.fn().mockResolvedValue(1) };
    const wrapped = wrapWithMultiProviderFailover([provider('p', impl)], fakeLogger());
    await expect((wrapped as unknown as typeof impl).getSlot()).resolves.toBe(1);
  });
});

describe('wrapWithMultiProviderFailover — rate-limit fast-rotate (2026-07-15 429 fix)', () => {
  it('rotates immediately on a 429 without sleeping/retrying the same provider', async () => {
    const rateLimited = {
      getSlot: vi.fn().mockRejectedValue(new Error('429 Too Many Requests: rate limit exceeded')),
    };
    const healthy = { getSlot: vi.fn().mockResolvedValue(7) };
    const wrapped = wrapWithMultiProviderFailover(
      [provider('limited', rateLimited), provider('healthy', healthy)],
      fakeLogger(),
      { retryDelayMs: 50_000 }, // would time out the test if the rate-limit path actually slept
    );

    await expect((wrapped as unknown as typeof healthy).getSlot()).resolves.toBe(7);
    // Exactly one attempt against the rate-limited provider, not two.
    expect(rateLimited.getSlot).toHaveBeenCalledTimes(1);
  });

  it('puts a rate-limited provider on cooldown after a single 429, same as exhausting both retries', async () => {
    const rateLimited = {
      getSlot: vi.fn().mockRejectedValue(new Error('429 Too Many Requests')),
    };
    const healthy = { getSlot: vi.fn().mockResolvedValue(1) };
    const wrapped = wrapWithMultiProviderFailover(
      [provider('limited', rateLimited), provider('healthy', healthy)],
      fakeLogger(),
    );

    await (wrapped as unknown as typeof healthy).getSlot();
    await (wrapped as unknown as typeof healthy).getSlot();

    // Cooldown means the second call's round-robin start never even reaches
    // the rate-limited provider a second time.
    expect(rateLimited.getSlot).toHaveBeenCalledTimes(1);
  });

  it('still retries the same provider once for a non-rate-limit transient error (unchanged behavior)', async () => {
    const flaky = {
      getSlot: vi.fn().mockRejectedValueOnce(new Error('ECONNRESET')).mockResolvedValueOnce(9),
    };
    const wrapped = wrapWithMultiProviderFailover([provider('flaky', flaky)], fakeLogger(), {
      retryDelayMs: 0,
    });

    await expect((wrapped as unknown as typeof flaky).getSlot()).resolves.toBe(9);
    expect(flaky.getSlot).toHaveBeenCalledTimes(2);
  });
});

describe('rpcRequestCounters (2026-07-15 429 fix)', () => {
  it('counts every real attempt per provider, and rate-limited attempts separately', async () => {
    const rateLimited = {
      getSlot: vi.fn().mockRejectedValue(new Error('429 Too Many Requests')),
    };
    const healthy = { getSlot: vi.fn().mockResolvedValue(1) };
    const wrapped = wrapWithMultiProviderFailover(
      [provider('limited', rateLimited), provider('healthy', healthy)],
      fakeLogger(),
    );

    await (wrapped as unknown as typeof healthy).getSlot();

    const snapshot = rpcRequestCounters.snapshot();
    expect(snapshot.attemptsByProvider.limited).toBe(1);
    expect(snapshot.attemptsByProvider.healthy).toBe(1);
    expect(snapshot.rateLimitedByProvider.limited).toBe(1);
    expect(snapshot.rateLimitedByProvider.healthy).toBeUndefined();
  });

  it('never counts a call that only ever hit the in-flight cache/dedup layer twice', async () => {
    const impl = { getAccountInfo: vi.fn().mockResolvedValue('x') };
    const wrapped = wrapWithMultiProviderFailover([provider('p', impl)], fakeLogger());

    await Promise.all([
      (wrapped as unknown as typeof impl).getAccountInfo('a'),
      (wrapped as unknown as typeof impl).getAccountInfo('a'),
    ]);

    expect(rpcRequestCounters.snapshot().attemptsByProvider.p).toBe(1);
  });

  it('counts a rate-limited rotate-away as a retry, distinct from a plain first-try success (2026-07-15 Helius credit audit)', async () => {
    const rateLimited = {
      getSlot: vi.fn().mockRejectedValue(new Error('429 Too Many Requests')),
    };
    const healthy = { getSlot: vi.fn().mockResolvedValue(1) };
    const wrapped = wrapWithMultiProviderFailover(
      [provider('limited', rateLimited), provider('healthy', healthy)],
      fakeLogger(),
    );

    await (wrapped as unknown as typeof healthy).getSlot();

    const snapshot = rpcRequestCounters.snapshot();
    expect(snapshot.retriesByProvider.limited).toBe(1);
    expect(snapshot.retriesByProvider.healthy).toBeUndefined();
  });

  it('counts a same-provider retry on a non-rate-limit transient error', async () => {
    const flaky = {
      getSlot: vi.fn().mockRejectedValueOnce(new Error('ECONNRESET')).mockResolvedValueOnce(9),
    };
    const wrapped = wrapWithMultiProviderFailover([provider('flaky', flaky)], fakeLogger(), {
      retryDelayMs: 0,
    });

    await (wrapped as unknown as typeof flaky).getSlot();

    expect(rpcRequestCounters.snapshot().retriesByProvider.flaky).toBe(1);
  });
});

describe('rpcCooldownRegistry (2026-07-15 Helius credit audit)', () => {
  it('records a provider cooldown when it is rate-limited', async () => {
    const rateLimited = {
      getSlot: vi.fn().mockRejectedValue(new Error('429 Too Many Requests')),
    };
    const healthy = { getSlot: vi.fn().mockResolvedValue(1) };
    const wrapped = wrapWithMultiProviderFailover(
      [provider('limited', rateLimited), provider('healthy', healthy)],
      fakeLogger(),
      { baseBackoffMs: 60_000, maxBackoffMs: 1_000_000 },
    );

    const before = Date.now();
    await (wrapped as unknown as typeof healthy).getSlot();

    const snapshot = rpcCooldownRegistry.snapshot();
    expect(snapshot.limited).toBeGreaterThan(before);
    // `healthy` succeeded on its first try, so its cooldown is explicitly
    // cleared to 0 (present, not on cooldown) rather than never recorded.
    expect(snapshot.healthy).toBe(0);
  });

  it('clears a provider back to 0 once it succeeds again', async () => {
    const flaky = {
      getSlot: vi
        .fn()
        .mockRejectedValueOnce(new Error('429 Too Many Requests'))
        .mockResolvedValueOnce(1),
    };
    const wrapped = wrapWithMultiProviderFailover([provider('flaky', flaky)], fakeLogger());

    await expect((wrapped as unknown as typeof flaky).getSlot()).rejects.toThrow();
    expect(rpcCooldownRegistry.snapshot().flaky).toBeGreaterThan(0);

    await (wrapped as unknown as typeof flaky).getSlot();
    expect(rpcCooldownRegistry.snapshot().flaky).toBe(0);
  });
});

describe('RpcLatencyRegistry', () => {
  it('records the first sample as-is, then exponentially smooths later ones', () => {
    rpcLatencyRegistry.record('helius', 100);
    expect(rpcLatencyRegistry.get('helius')).toBe(100);

    rpcLatencyRegistry.record('helius', 200);
    // 100 * 0.7 + 200 * 0.3 = 130
    expect(rpcLatencyRegistry.get('helius')).toBeCloseTo(130);
  });

  it('get() returns undefined for a label with no recorded sample', () => {
    expect(rpcLatencyRegistry.get('never-benchmarked')).toBeUndefined();
  });

  it('snapshot() reflects every recorded label', () => {
    rpcLatencyRegistry.record('helius', 50);
    rpcLatencyRegistry.record('quicknode', 75);
    expect(rpcLatencyRegistry.snapshot()).toEqual({ helius: 50, quicknode: 75 });
  });
});

describe('wrapWithMultiProviderFailover — RPC benchmarking (Stage 2, 2026-07-14)', () => {
  it('never probes any provider when benchmarkIntervalMs is unset — byte-identical to pre-Stage-2 behavior', async () => {
    const primary = {
      getSlot: vi.fn().mockResolvedValue(1),
      getBalance: vi.fn().mockResolvedValue(1),
    };
    wrapWithMultiProviderFailover([provider('primary', primary)], fakeLogger());

    // Give any stray timer a chance to fire, if one were mistakenly created.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(primary.getSlot).not.toHaveBeenCalled();
  });

  it('seeds an immediate benchmark sample on construction when benchmarkIntervalMs is set, without waiting a full interval', async () => {
    const primary = { getSlot: vi.fn().mockResolvedValue(1) };
    const secondary = { getSlot: vi.fn().mockResolvedValue(2) };
    wrapWithMultiProviderFailover(
      [provider('primary', primary), provider('secondary', secondary)],
      fakeLogger(),
      { benchmarkIntervalMs: 60_000 },
    );

    // The seed probe is fire-and-forget (not awaited by the constructor) —
    // flush the microtask queue so it has a chance to resolve.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(primary.getSlot).toHaveBeenCalledTimes(1);
    expect(secondary.getSlot).toHaveBeenCalledTimes(1);
    expect(rpcLatencyRegistry.get('primary')).toBeDefined();
    expect(rpcLatencyRegistry.get('secondary')).toBeDefined();
  });

  it('reorders healthy providers fastest-known-latency-first once benchmarking has a sample', async () => {
    rpcLatencyRegistry.record('slow', 500);
    rpcLatencyRegistry.record('fast', 10);

    const slow = { getBalance: vi.fn().mockResolvedValue('from-slow') };
    const fast = { getBalance: vi.fn().mockResolvedValue('from-fast') };
    // Listed slow-first, so this also proves it's latency (not list order or
    // round-robin) driving the choice.
    const wrapped = wrapWithMultiProviderFailover(
      [provider('slow', slow), provider('fast', fast)],
      fakeLogger(),
      { benchmarkIntervalMs: 60_000 },
    );

    const result = await (wrapped as unknown as typeof fast).getBalance('walletX');

    expect(result).toBe('from-fast');
    expect(fast.getBalance).toHaveBeenCalledTimes(1);
    expect(slow.getBalance).not.toHaveBeenCalled();
  });

  it('a provider with no benchmark sample yet is never assumed fast — providers with real data are preferred', async () => {
    rpcLatencyRegistry.record('known-fast', 10);
    // 'unknown' deliberately gets no recorded sample.

    const unknown = { getBalance: vi.fn().mockResolvedValue('from-unknown') };
    const knownFast = { getBalance: vi.fn().mockResolvedValue('from-known-fast') };
    const wrapped = wrapWithMultiProviderFailover(
      [provider('unknown', unknown), provider('known-fast', knownFast)],
      fakeLogger(),
      { benchmarkIntervalMs: 60_000 },
    );

    const result = await (wrapped as unknown as typeof knownFast).getBalance('walletX');
    expect(result).toBe('from-known-fast');
  });

  it('a provider still on error-cooldown is skipped even if it has the best latency sample', async () => {
    rpcLatencyRegistry.record('fast-but-erroring', 5);
    rpcLatencyRegistry.record('slower-but-healthy', 500);

    const erroring = { getSlot: vi.fn().mockRejectedValue(new Error('429 too many requests')) };
    const healthy = { getSlot: vi.fn().mockResolvedValue(1) };
    const wrapped = wrapWithMultiProviderFailover(
      [provider('fast-but-erroring', erroring), provider('slower-but-healthy', healthy)],
      fakeLogger(),
      { benchmarkIntervalMs: 60_000, retryDelayMs: 0, baseBackoffMs: 60_000 },
    );

    // Trips the erroring provider into cooldown (two consecutive failures).
    await (wrapped as unknown as typeof erroring).getSlot();
    erroring.getSlot.mockClear();
    healthy.getSlot.mockClear();

    await (wrapped as unknown as typeof erroring).getSlot();
    expect(erroring.getSlot).not.toHaveBeenCalled();
    expect(healthy.getSlot).toHaveBeenCalledTimes(1);
  });

  it('a benchmark probe that fails/times out leaves the provider healthy — it never trips the error-cooldown by itself', async () => {
    const flaky = {
      getSlot: vi.fn().mockRejectedValue(new Error('probe failed')),
      getBalance: vi.fn().mockResolvedValue('ok'),
    };
    const wrapped = wrapWithMultiProviderFailover([provider('flaky', flaky)], fakeLogger(), {
      benchmarkIntervalMs: 60_000,
    });

    await new Promise((resolve) => setTimeout(resolve, 0)); // let the seed probe run and fail
    expect(rpcLatencyRegistry.get('flaky')).toBeUndefined(); // no sample recorded

    // A real call still goes straight through — the failed probe never
    // touched the error-cooldown state.
    const result = await (wrapped as unknown as typeof flaky).getBalance('walletX');
    expect(result).toBe('ok');
  });

  it('subscription methods always bind to the first configured provider, never affected by latency-based reordering', () => {
    // Live-verified production constraint (see SUBSCRIPTION_METHODS's own doc
    // comment): only providers[0]'s WSS subscriptions are ever real — Stage 2's
    // benchmarking must never change which provider that is.
    rpcLatencyRegistry.record('primary', 900); // deliberately the slowest
    rpcLatencyRegistry.record('secondary', 5); // deliberately the fastest

    const primary = { onLogs: vi.fn().mockReturnValue(42) };
    const secondary = { onLogs: vi.fn() };
    const wrapped = wrapWithMultiProviderFailover(
      [provider('primary', primary), provider('secondary', secondary)],
      fakeLogger(),
      { benchmarkIntervalMs: 60_000 },
    );

    const subId = (wrapped as unknown as typeof primary).onLogs('filter', () => {});

    expect(subId).toBe(42);
    expect(primary.onLogs).toHaveBeenCalledTimes(1);
    expect(secondary.onLogs).not.toHaveBeenCalled();
  });
});

describe('wrapWithMultiProviderFailover — call timeout (2026-07-30 incident fix)', () => {
  // Live production incident, 2026-07-30: a provider that accepted the
  // request but never responded (not even an error) left callProvider's
  // returned promise pending forever — no code path existed to ever resolve
  // or reject it. That hung promise was awaited inside PositionManager's sell
  // path while holding positionCloseLock, which froze PriceMonitor.tick's
  // `ticking` re-entrancy guard (Promise.allSettled never settles while one
  // member never settles) for every open position, not just the stuck one,
  // for 3h19m — stop-loss simply never got to run again until a human
  // manually restarted the process. A position that should have stopped out
  // at -20% closed at -94%. These tests prove a never-settling provider call
  // can no longer hang forever: it's now treated as a retryable timeout,
  // exactly like any other transient RPC failure.
  it('a call that never resolves is treated as a retryable timeout and rotates to the next provider', async () => {
    const primary = { getLatestBlockhash: vi.fn(() => new Promise(() => {})) }; // never settles
    const secondary = { getLatestBlockhash: vi.fn().mockResolvedValue({ blockhash: 'abc' }) };
    const wrapped = wrapWithMultiProviderFailover(
      [provider('primary', primary), provider('secondary', secondary)],
      fakeLogger(),
      { retryDelayMs: 0, callTimeoutMs: 10 },
    );

    const result = await (wrapped as unknown as typeof secondary).getLatestBlockhash();

    expect(result).toEqual({ blockhash: 'abc' });
    expect(secondary.getLatestBlockhash).toHaveBeenCalledTimes(1);
  });

  it('never leaves the call pending forever even when every provider hangs', async () => {
    const primary = { sendTransaction: vi.fn((..._args: unknown[]) => new Promise(() => {})) };
    const secondary = { sendTransaction: vi.fn((..._args: unknown[]) => new Promise(() => {})) };
    const wrapped = wrapWithMultiProviderFailover(
      [provider('primary', primary), provider('secondary', secondary)],
      fakeLogger(),
      { retryDelayMs: 0, callTimeoutMs: 10 },
    );

    await expect((wrapped as unknown as typeof primary).sendTransaction('tx')).rejects.toThrow(
      /timed out/i,
    );
  });

  it('confirmTransaction is governed by confirmTransactionTimeoutMs, not the shorter callTimeoutMs', async () => {
    // Resolves after 50ms — longer than callTimeoutMs (10ms) but well within
    // confirmTransactionTimeoutMs (200ms). If confirmTransaction were
    // (incorrectly) subject to callTimeoutMs like every other method, this
    // provider would time out and the call would rotate to secondary; it
    // must instead succeed on primary without ever touching secondary.
    const primary = {
      confirmTransaction: vi.fn(
        (..._args: unknown[]) =>
          new Promise((resolve) => setTimeout(() => resolve({ value: { err: null } }), 50)),
      ),
    };
    const secondary = { confirmTransaction: vi.fn() };
    const wrapped = wrapWithMultiProviderFailover(
      [provider('primary', primary), provider('secondary', secondary)],
      fakeLogger(),
      { retryDelayMs: 0, callTimeoutMs: 10, confirmTransactionTimeoutMs: 200 },
    );

    const result = await (wrapped as unknown as typeof primary).confirmTransaction('sig');

    expect(result).toEqual({ value: { err: null } });
    expect(secondary.confirmTransaction).not.toHaveBeenCalled();
  });

  it('a call that resolves well within the timeout is unaffected', async () => {
    const primary = { getBalance: vi.fn().mockResolvedValue(123) };
    const wrapped = wrapWithMultiProviderFailover([provider('primary', primary)], fakeLogger(), {
      callTimeoutMs: 5_000,
    });

    const result = await (wrapped as unknown as typeof primary).getBalance('pubkey');

    expect(result).toBe(123);
  });
});
