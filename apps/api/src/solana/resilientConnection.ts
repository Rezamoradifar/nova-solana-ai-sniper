import { Connection } from '@solana/web3.js';

const RETRYABLE_PATTERNS = [
  '429',
  'too many requests',
  'max usage reached',
  'rate limit',
  'timeout',
  'timed out',
  'econnreset',
  'econnrefused',
  'etimedout',
  'fetch failed',
  'socket hang up',
  'network error',
  'service unavailable',
  '502',
  '503',
  '504',
];

function isRetryable(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();
  return RETRYABLE_PATTERNS.some((p) => lower.includes(p));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface RpcProviderConfig {
  /** Human-readable name for logging (e.g. "helius", "quicknode", "public"). */
  label: string;
  connection: Connection;
}

export interface ResilientConnectionOptions {
  /** Called (best-effort, never thrown from) whenever a call retries or rotates provider. */
  onFailover?: (info: { method: string; attempt: number; provider: string }) => void;
  /** Delay before retrying the same provider once, before rotating to the next. */
  retryDelayMs?: number;
  /** Base delay for a provider's exponential-backoff cooldown after it fails twice in a row. */
  baseBackoffMs?: number;
  /** Ceiling on a provider's backoff cooldown, however many times it's failed consecutively. */
  maxBackoffMs?: number;
  /** How long a successful read of a cacheable method is reused for an identical call. */
  cacheTtlMs?: number;
}

/**
 * Subscription-registration methods return a plain subscription id/void
 * synchronously and must always bind to one single, stable provider — rotating
 * or retrying them across providers would silently duplicate the subscription
 * (double-fired events) or orphan it (retry on a different provider than the one
 * the caller thinks it's subscribed to). These always go straight to the first
 * configured provider, called exactly once, exactly like a plain Connection.
 */
const SUBSCRIPTION_METHODS = new Set([
  'onAccountChange',
  'onLogs',
  'onProgramAccountChange',
  'onSignature',
  'onSignatureWithOptions',
  'onSlotChange',
  'onSlotUpdate',
  'onRootChange',
  'removeAccountChangeListener',
  'removeOnLogsListener',
  'removeProgramAccountChangeListener',
  'removeSignatureListener',
  'removeSlotChangeListener',
  'removeSlotUpdateListener',
  'removeRootChangeListener',
]);

/**
 * Idempotent, read-only lookups only — safe to de-dupe/cache without changing
 * behavior. Deliberately excludes anything the trading path needs fresh on every
 * call (getBalance, getLatestBlockhash, getSignatureStatus(es)) and anything
 * that isn't a pure read (sendTransaction, confirmTransaction, simulateTransaction) —
 * caching those would change trading semantics, not just save RPC calls.
 */
const CACHEABLE_METHODS = new Set([
  'getAccountInfo',
  'getMultipleAccountsInfo',
  'getParsedAccountInfo',
  'getTokenSupply',
  'getTokenLargestAccounts',
  'getTokenAccountBalance',
  'getParsedTokenAccountsByOwner',
  'getMinimumBalanceForRentExemption',
]);

function keyPart(arg: unknown): string {
  if (arg && typeof arg === 'object' && 'toBase58' in arg && typeof arg.toBase58 === 'function') {
    return (arg as { toBase58(): string }).toBase58();
  }
  if (Array.isArray(arg)) return `[${arg.map(keyPart).join(',')}]`;
  if (arg && typeof arg === 'object') return JSON.stringify(arg);
  return String(arg);
}

function cacheKeyFor(method: string, args: unknown[]): string {
  return `${method}(${args.map(keyPart).join(',')})`;
}

interface ProviderState {
  failureCount: number;
  cooldownUntil: number;
}

/**
 * Wraps an ordered list of Connections (Helius, QuickNode, Chainstack, the public
 * mainnet-beta endpoint, or any other configured RPC provider) so every Promise-
 * returning RPC method transparently load-balances across whichever providers are
 * currently healthy, retries once against the same provider, then rotates through
 * the rest before giving up — without requiring any change at call sites (every
 * existing `connection.getX(...)` / `connection.sendTransaction(...)` call keeps
 * working exactly as before, just with real resilience behind it now).
 *
 * A provider that just failed twice in a row on a retryable error (rate limit,
 * timeout, gateway error) is put on an exponential-backoff cooldown and skipped
 * by later calls until it expires — so a saturated provider stops being retried
 * on every single call, and load naturally shifts to whichever providers aren't
 * currently failing. This is failover *and* load balancing together: rotation
 * spreads normal traffic across every healthy provider (not just "always
 * provider #1 until it dies"), and cooldown gives a struggling one a break
 * instead of hammering it further.
 *
 * A safelist of read-only, idempotent methods (see CACHEABLE_METHODS) also gets
 * in-flight de-duplication (concurrent identical calls share one real RPC round
 * trip) and a short TTL cache — the concrete production gap this closes: multiple
 * detection code paths (registry.resolveNewPool, migrationMonitor, riskAnalyzer)
 * routinely re-fetch the same account within milliseconds of each other.
 */
export function wrapWithMultiProviderFailover(
  providers: RpcProviderConfig[],
  logger: { warn: (obj: unknown, msg: string) => void },
  options: ResilientConnectionOptions = {},
): Connection {
  if (providers.length === 0) {
    throw new Error('wrapWithMultiProviderFailover requires at least one provider');
  }

  const retryDelayMs = options.retryDelayMs ?? 250;
  const baseBackoffMs = options.baseBackoffMs ?? 1_000;
  const maxBackoffMs = options.maxBackoffMs ?? 30_000;
  const cacheTtlMs = options.cacheTtlMs ?? 2_000;

  const state = new Map<string, ProviderState>(
    providers.map((p) => [p.label, { failureCount: 0, cooldownUntil: 0 }]),
  );
  const cache = new Map<string, { value: unknown; cachedAt: number }>();
  const inFlight = new Map<string, Promise<unknown>>();
  let rotation = 0;

  function backoffFor(failureCount: number): number {
    return Math.min(maxBackoffMs, baseBackoffMs * 2 ** failureCount);
  }

  /** Healthy (off-cooldown) providers first in rotation order, unhealthy ones last as a last resort. */
  function orderedProviders(): RpcProviderConfig[] {
    const start = rotation % providers.length;
    rotation += 1;
    const rotated = [...providers.slice(start), ...providers.slice(0, start)];
    const now = Date.now();
    const healthy = rotated.filter((p) => state.get(p.label)!.cooldownUntil <= now);
    const unhealthy = rotated.filter((p) => state.get(p.label)!.cooldownUntil > now);
    return [...healthy, ...unhealthy];
  }

  function callProvider(
    provider: RpcProviderConfig,
    prop: string,
    args: unknown[],
  ): Promise<unknown> {
    const fn = (provider.connection as unknown as Record<string, (...a: unknown[]) => unknown>)[
      prop
    ]!;
    return Promise.resolve(fn.apply(provider.connection, args));
  }

  async function runWithFailover(prop: string, args: unknown[]): Promise<unknown> {
    const candidates = orderedProviders();
    let lastErr: unknown;

    for (let i = 0; i < candidates.length; i++) {
      const provider = candidates[i]!;
      const st = state.get(provider.label)!;
      try {
        const result = await callProvider(provider, prop, args);
        st.failureCount = 0;
        st.cooldownUntil = 0;
        return result;
      } catch (firstErr) {
        lastErr = firstErr;
        if (!isRetryable(firstErr)) throw firstErr;

        logger.warn(
          { method: prop, provider: provider.label, err: firstErr },
          'RPC call failed — retrying against the same provider',
        );
        options.onFailover?.({ method: prop, attempt: 1, provider: provider.label });
        await sleep(retryDelayMs);

        try {
          const result = await callProvider(provider, prop, args);
          st.failureCount = 0;
          st.cooldownUntil = 0;
          return result;
        } catch (secondErr) {
          lastErr = secondErr;
          if (!isRetryable(secondErr)) throw secondErr;

          st.failureCount += 1;
          st.cooldownUntil = Date.now() + backoffFor(st.failureCount);
          const hasMore = i < candidates.length - 1;
          logger.warn(
            {
              method: prop,
              provider: provider.label,
              err: secondErr,
              cooldownUntil: st.cooldownUntil,
            },
            hasMore
              ? 'RPC call still failing — rotating to the next provider'
              : 'RPC call still failing — no more providers left to try',
          );
          options.onFailover?.({ method: prop, attempt: 2, provider: provider.label });
          // fall through to the next candidate
        }
      }
    }

    throw lastErr;
  }

  async function runCached(prop: string, args: unknown[]): Promise<unknown> {
    const key = cacheKeyFor(prop, args);

    const cached = cache.get(key);
    if (cached && Date.now() - cached.cachedAt < cacheTtlMs) {
      return cached.value;
    }

    const existing = inFlight.get(key);
    if (existing) return existing;

    const promise = runWithFailover(prop, args)
      .then((value) => {
        cache.set(key, { value, cachedAt: Date.now() });
        return value;
      })
      .finally(() => {
        inFlight.delete(key);
      });
    inFlight.set(key, promise);
    return promise;
  }

  const primary = providers[0]!.connection;

  return new Proxy(primary, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function' || typeof prop !== 'string') {
        return value;
      }

      if (SUBSCRIPTION_METHODS.has(prop)) {
        return value.bind(target);
      }

      const cacheable = CACHEABLE_METHODS.has(prop);
      return function (this: unknown, ...args: unknown[]) {
        return cacheable ? runCached(prop, args) : runWithFailover(prop, args);
      };
    },
  }) as never as Connection;
}
