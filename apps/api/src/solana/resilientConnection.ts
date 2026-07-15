import { Connection } from '@solana/web3.js';

// Rate-limit errors are split out from the broader retryable set (below) because
// they need different handling: retrying the SAME provider that just told you
// "too many requests" only adds load to an endpoint that's already over its
// limit and wastes the retry window — see runWithFailover's use of this, which
// skips the local same-provider retry and rotates immediately on a rate-limit
// error, instead of sleeping+retrying in place like it does for a transient
// timeout/network error.
const RATE_LIMIT_PATTERNS = [
  '429',
  'too many requests',
  'max usage reached',
  'rate limit',
  'rate limits exceeded',
];

const RETRYABLE_PATTERNS = [
  ...RATE_LIMIT_PATTERNS,
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
  // Some providers (e.g. QuickNode's Discover plan) cap getMultipleAccounts
  // batch size well below the 100-account Solana protocol limit and reject
  // larger batches with 413 rather than a plain rate-limit error — without
  // this, that plan-specific cap kills the call outright on the very first
  // provider instead of rotating to one that supports the full batch size.
  '413',
  'request entity too large',
];

function matches(err: unknown, patterns: readonly string[]): boolean {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();
  return patterns.some((p) => lower.includes(p));
}

function isRetryable(err: unknown): boolean {
  return matches(err, RETRYABLE_PATTERNS);
}

function isRateLimited(err: unknown): boolean {
  return matches(err, RATE_LIMIT_PATTERNS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface RpcProviderConfig {
  /** Human-readable name for logging (e.g. "helius", "quicknode", "public"). */
  label: string;
  connection: Connection;
  /**
   * 'fallback' providers (shared/free public RPC endpoints, with far lower rate
   * limits than a paid provider) are only ever reached after every 'primary'
   * provider is on cooldown — see orderedProviders(). Defaults to 'primary' so
   * every existing caller/test that doesn't set this is unaffected. Added
   * 2026-07-15: `SOLANA_RPC_URL` pointing at the same public endpoint as the
   * hardcoded DEFAULT_PUBLIC_RPC fallback meant round-robin gave Solana's
   * public RPC an equal ~1/3 share of all traffic — a share its rate limit
   * cannot sustain — causing the constant 429s this tier fixes.
   */
  tier?: 'primary' | 'fallback';
}

/**
 * Process-wide count of every RPC call attempt and rate-limit rejection per
 * provider — the concrete "requests per second" / "which provider" visibility
 * that was previously only inferable from grepping warn-level retry logs (which
 * only capture *failures*, never successes). Same plain-singleton convention as
 * RpcLatencyRegistry above.
 */
class RpcRequestCounters {
  private readonly attemptsByLabel = new Map<string, number>();
  private readonly rateLimitedByLabel = new Map<string, number>();
  // 2026-07-15 Helius credit audit: distinct from rateLimitedByLabel — this
  // counts every same-provider-retry or rotate-to-next-provider attempt
  // (i.e. every attempt beyond the first for a single logical call),
  // regardless of whether the failure that triggered it was a rate limit or
  // any other retryable error (timeout, 5xx, ...).
  private readonly retriesByLabel = new Map<string, number>();
  private readonly startedAt = Date.now();

  recordAttempt(label: string): void {
    this.attemptsByLabel.set(label, (this.attemptsByLabel.get(label) ?? 0) + 1);
  }

  recordRateLimited(label: string): void {
    this.rateLimitedByLabel.set(label, (this.rateLimitedByLabel.get(label) ?? 0) + 1);
  }

  recordRetry(label: string): void {
    this.retriesByLabel.set(label, (this.retriesByLabel.get(label) ?? 0) + 1);
  }

  snapshot(): {
    sinceMs: number;
    attemptsByProvider: Record<string, number>;
    rateLimitedByProvider: Record<string, number>;
    retriesByProvider: Record<string, number>;
    attemptsPerSecondByProvider: Record<string, number>;
  } {
    const sinceMs = Date.now() - this.startedAt;
    const seconds = Math.max(sinceMs / 1000, 1);
    const attemptsPerSecondByProvider: Record<string, number> = {};
    for (const [label, count] of this.attemptsByLabel) {
      attemptsPerSecondByProvider[label] = Math.round((count / seconds) * 1000) / 1000;
    }
    return {
      sinceMs,
      attemptsByProvider: Object.fromEntries(this.attemptsByLabel),
      rateLimitedByProvider: Object.fromEntries(this.rateLimitedByLabel),
      retriesByProvider: Object.fromEntries(this.retriesByLabel),
      attemptsPerSecondByProvider,
    };
  }

  /** Test-only: clears all recorded samples so tests never leak into each other. */
  reset(): void {
    this.attemptsByLabel.clear();
    this.rateLimitedByLabel.clear();
    this.retriesByLabel.clear();
  }
}

export const rpcRequestCounters = new RpcRequestCounters();

/**
 * 2026-07-15 Helius credit audit: process-wide readout of each provider's
 * current backoff cooldown — previously trapped inside
 * wrapWithMultiProviderFailover's closure-private `state` map. "Provider X is
 * on cooldown until Y" is a more directly actionable signal for diagnosing
 * exhaustion than raw counts alone. Same plain-singleton convention as
 * RpcLatencyRegistry.
 */
class RpcCooldownRegistry {
  private readonly cooldownUntilByLabel = new Map<string, number>();

  record(label: string, cooldownUntil: number): void {
    this.cooldownUntilByLabel.set(label, cooldownUntil);
  }

  snapshot(): Record<string, number> {
    return Object.fromEntries(this.cooldownUntilByLabel);
  }

  /** Test-only: clears all recorded samples so tests never leak into each other. */
  reset(): void {
    this.cooldownUntilByLabel.clear();
  }
}

export const rpcCooldownRegistry = new RpcCooldownRegistry();

/**
 * Stage 2 (2026-07-14): shared, process-wide record of each provider's most
 * recently benchmarked latency — separate from wrapWithMultiProviderFailover's
 * own closure-private `state`/`cache` so it's readable from outside (e.g. a
 * future /metrics route) without threading a connection handle through. Same
 * plain-singleton convention as metrics.ts/latencyTracker.ts. Only ever
 * written by wrapWithMultiProviderFailover's benchmark loop below.
 */
class RpcLatencyRegistry {
  private readonly latencyByLabel = new Map<string, number>();

  /** Exponential moving average — smooths one-off jitter without needing to
   * retain a rolling window of samples per provider. */
  record(label: string, latencyMs: number): void {
    const prev = this.latencyByLabel.get(label);
    this.latencyByLabel.set(label, prev === undefined ? latencyMs : prev * 0.7 + latencyMs * 0.3);
  }

  get(label: string): number | undefined {
    return this.latencyByLabel.get(label);
  }

  snapshot(): Record<string, number> {
    return Object.fromEntries(this.latencyByLabel);
  }

  /** Test-only: clears all recorded samples so tests never leak into each other. */
  reset(): void {
    this.latencyByLabel.clear();
  }
}

export const rpcLatencyRegistry = new RpcLatencyRegistry();

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
  /**
   * Stage 2 (2026-07-14): when set, starts a continuous background latency
   * benchmark (a cheap getSlot() probe against every configured provider,
   * repeated every `benchmarkIntervalMs`) and reorders healthy providers by
   * measured latency — fastest first — instead of plain round-robin.
   * Undefined (the default) preserves today's exact round-robin rotation
   * byte-for-byte; only production's getConnection() wiring opts in. See
   * orderedProviders()'s doc comment for exactly how the two interact.
   */
  benchmarkIntervalMs?: number;
  /** Ceiling on a single benchmark probe before it's treated as a failed
   * sample (doesn't update the latency estimate, doesn't throw). */
  benchmarkTimeoutMs?: number;
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
 *
 * getParsedTransaction (added 2026-07-15 Helius credit audit): content for a
 * fixed signature is immutable once returned, unlike account-info reads that
 * change over time — safe to cache/dedupe. The concrete gap this closes: the
 * pump.fun migration-hint path and the DEX pool-creation path in worker.ts
 * can both fetch the same signature within the same tick. This is ONLY safe
 * because runCached (below) never caches a null/undefined result — a
 * transaction can transiently resolve null before it's visible yet
 * (positionManager.ts's withVerificationRetry retries specifically for this),
 * and caching that null for cacheTtlMs would silently defeat that retry.
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
  'getParsedTransaction',
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

  /** ±20% jitter so many callers backing off at once don't retry in lockstep. */
  function withJitter(ms: number): number {
    return Math.round(ms * (0.8 + Math.random() * 0.4));
  }

  function backoffFor(failureCount: number): number {
    return withJitter(Math.min(maxBackoffMs, baseBackoffMs * 2 ** failureCount));
  }

  // Stage 2 (2026-07-14): continuous latency benchmarking, opt-in via
  // benchmarkIntervalMs (see ResilientConnectionOptions's doc comment).
  // Probes every configured provider concurrently with a cheap getSlot()
  // call, on its own short timeout so one hung provider can never delay the
  // others' samples or pile up overlapping probes. A failed/timed-out probe
  // simply leaves that provider's last known latency in place (or "unknown"
  // if there's never been a successful one) — it does NOT touch `state`
  // (the existing error-cooldown map above), so probe failures alone can
  // never trip a provider into cooldown; only a real call failure does that,
  // exactly as before this stage.
  if (options.benchmarkIntervalMs) {
    const benchmarkTimeoutMs = options.benchmarkTimeoutMs ?? 3_000;
    const benchmarkTick = async (): Promise<void> => {
      await Promise.all(
        providers.map(async (p) => {
          const startedAt = Date.now();
          try {
            await Promise.race([
              p.connection.getSlot(),
              new Promise((_, reject) =>
                setTimeout(
                  () => reject(new Error('benchmark probe timed out')),
                  benchmarkTimeoutMs,
                ),
              ),
            ]);
            rpcLatencyRegistry.record(p.label, Date.now() - startedAt);
          } catch {
            // No sample this tick — see doc comment above.
          }
        }),
      );
    };
    const timer = setInterval(() => void benchmarkTick(), options.benchmarkIntervalMs);
    // Never keeps the process alive on its own (same convention as every
    // other interval-driven monitor in this codebase relies on the process's
    // other work, e.g. the HTTP server, to stay up) — a benchmark loop with
    // nothing left to benchmark for should never block a clean shutdown.
    timer.unref?.();
    void benchmarkTick(); // seed a real sample immediately, don't wait a full interval for the first one
  }

  /**
   * Primary-tier providers first, fallback-tier last — regardless of health —
   * so a shared/free public RPC endpoint (see RpcProviderConfig.tier's doc
   * comment) is only ever reached once every primary provider is unhealthy,
   * instead of getting an equal round-robin share of ordinary traffic. Within
   * each tier: healthy (off-cooldown) providers first, unhealthy ones last as
   * a last resort — unchanged. Stage 2 (2026-07-14): when benchmarking is
   * enabled and has at least one sample, healthy providers are additionally
   * sorted fastest-known-latency-first (stable sort, so any provider with no
   * sample yet keeps its round-robin position, ordered after every provider
   * that DOES have fresh data — never assumed fast without evidence). This is
   * a deliberate tradeoff against the round-robin's built-in load-spreading
   * (see this function's own doc comment above) — the explicit ask for this
   * stage was "always the fastest," and a provider that starts truly
   * struggling (errors, not just relative slowness) still falls into the
   * existing cooldown path below regardless of this ordering.
   */
  function orderedProviders(): RpcProviderConfig[] {
    const start = rotation % providers.length;
    rotation += 1;
    const rotated = [...providers.slice(start), ...providers.slice(0, start)];
    const now = Date.now();

    const order = (list: RpcProviderConfig[]): RpcProviderConfig[] => {
      const healthy = list.filter((p) => state.get(p.label)!.cooldownUntil <= now);
      const unhealthy = list.filter((p) => state.get(p.label)!.cooldownUntil > now);
      if (options.benchmarkIntervalMs) {
        healthy.sort((a, b) => {
          const la = rpcLatencyRegistry.get(a.label);
          const lb = rpcLatencyRegistry.get(b.label);
          if (la === undefined && lb === undefined) return 0;
          if (la === undefined) return 1;
          if (lb === undefined) return -1;
          return la - lb;
        });
      }
      return [...healthy, ...unhealthy];
    };

    const primary = rotated.filter((p) => (p.tier ?? 'primary') === 'primary');
    const fallback = rotated.filter((p) => (p.tier ?? 'primary') === 'fallback');
    return [...order(primary), ...order(fallback)];
  }

  function callProvider(
    provider: RpcProviderConfig,
    prop: string,
    args: unknown[],
  ): Promise<unknown> {
    rpcRequestCounters.recordAttempt(provider.label);
    const fn = (provider.connection as unknown as Record<string, (...a: unknown[]) => unknown>)[
      prop
    ]!;
    return Promise.resolve(fn.apply(provider.connection, args));
  }

  /** Applies backoff cooldown and rotates — shared by the rate-limited fast
   * path and the exhausted-retry path below, so both leave `state` consistent. */
  function failAndCooldown(provider: RpcProviderConfig): void {
    const st = state.get(provider.label)!;
    st.failureCount += 1;
    st.cooldownUntil = Date.now() + backoffFor(st.failureCount);
    rpcCooldownRegistry.record(provider.label, st.cooldownUntil);
  }

  function clearCooldown(provider: RpcProviderConfig, st: ProviderState): void {
    st.failureCount = 0;
    st.cooldownUntil = 0;
    rpcCooldownRegistry.record(provider.label, 0);
  }

  async function runWithFailover(prop: string, args: unknown[]): Promise<unknown> {
    const candidates = orderedProviders();
    let lastErr: unknown;

    for (let i = 0; i < candidates.length; i++) {
      const provider = candidates[i]!;
      const st = state.get(provider.label)!;
      const hasMore = i < candidates.length - 1;
      try {
        const result = await callProvider(provider, prop, args);
        clearCooldown(provider, st);
        return result;
      } catch (firstErr) {
        lastErr = firstErr;
        if (!isRetryable(firstErr)) throw firstErr;

        if (isRateLimited(firstErr)) {
          // Retrying the same provider that just said "too many requests"
          // only adds load to an endpoint already over its limit — rotate
          // immediately instead of sleeping+retrying in place.
          rpcRequestCounters.recordRateLimited(provider.label);
          rpcRequestCounters.recordRetry(provider.label);
          failAndCooldown(provider);
          logger.warn(
            {
              method: prop,
              provider: provider.label,
              err: firstErr,
              cooldownUntil: st.cooldownUntil,
            },
            hasMore
              ? 'RPC call rate-limited — rotating to the next provider immediately'
              : 'RPC call rate-limited — no more providers left to try',
          );
          options.onFailover?.({ method: prop, attempt: 1, provider: provider.label });
          continue;
        }

        logger.warn(
          { method: prop, provider: provider.label, err: firstErr },
          'RPC call failed — retrying against the same provider',
        );
        rpcRequestCounters.recordRetry(provider.label);
        options.onFailover?.({ method: prop, attempt: 1, provider: provider.label });
        await sleep(withJitter(retryDelayMs));

        try {
          const result = await callProvider(provider, prop, args);
          clearCooldown(provider, st);
          return result;
        } catch (secondErr) {
          lastErr = secondErr;
          if (!isRetryable(secondErr)) throw secondErr;
          if (isRateLimited(secondErr)) rpcRequestCounters.recordRateLimited(provider.label);

          failAndCooldown(provider);
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
          rpcRequestCounters.recordRetry(provider.label);
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
        // Never cache a null/undefined result — a not-yet-visible read (e.g.
        // getParsedTransaction before the tx has landed from this provider's
        // point of view) must be retried fresh, not served back a stale
        // "not found" for the rest of the TTL window. In-flight de-dup above
        // still applies regardless (cleared in .finally() either way), so
        // concurrent identical calls still collapse into one real request.
        if (value !== null && value !== undefined) {
          cache.set(key, { value, cachedAt: Date.now() });
        }
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
