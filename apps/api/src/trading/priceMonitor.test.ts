import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { Connection } from '@solana/web3.js';
import { PriceMonitor, type PriceMonitorDeps } from './priceMonitor.js';
import type { PositionManager } from './positionManager.js';
import type { DexScreenerClient } from '../solana/dexscreener.js';
import type { JupiterClient } from '../solana/jupiter.js';

vi.mock('../solana/pumpfunBondingCurve.js', () => ({
  sharedSolPriceOracle: { getPriceUsd: vi.fn().mockResolvedValue(150) },
}));

function fakeLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
}

function fakePosition(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pos-1',
    walletId: 'wallet-1',
    entryPriceUsd: 1,
    highWaterMarkUsd: 1,
    stopLossPercent: 20,
    stopLossIsSystemDefault: true,
    amountToken: 1_000_000,
    remainingAmountToken: 1_000_000,
    // Real, validly-formatted base58 Solana pubkeys — getRealTokenBalance
    // constructs a real PublicKey from these, which throws on a placeholder
    // string like "WalletPubKey111...".
    wallet: {
      publicKey: '8dGyL4FaTQ1yfQYPr3VAJGWKXDNRZ91LGp2cUoCG5LLK',
      encryptedSecret: 'secret',
    },
    token: {
      mint: 'ED5nyyWEzpPPiWimP8vYm7sD7TD3LAt3Q3gRTWHzPJBY',
      decimals: 6,
      dex: 'RAYDIUM',
      poolAddress: null,
      symbol: 'ABC',
    },
    monitoringState: 'NORMAL',
    monitoringStateSince: null,
    lastMonitoringAlertAt: null,
    lastAlertedMonitoringState: null,
    ...overrides,
  };
}

function fakeConnectionWithBalance(rawAmount: string) {
  return {
    getParsedTokenAccountsByOwner: vi.fn().mockResolvedValue({
      value:
        rawAmount === '0'
          ? []
          : [{ account: { data: { parsed: { info: { tokenAmount: { amount: rawAmount } } } } } }],
    }),
  } as unknown as Connection;
}

function buildDeps(
  overrides: Partial<PriceMonitorDeps> = {},
  positions: unknown[] = [],
): PriceMonitorDeps & {
  positionManager: {
    closePosition: ReturnType<typeof vi.fn>;
    checkAndMaybeClose: ReturnType<typeof vi.fn>;
  };
} {
  const positionManager = {
    closePosition: vi.fn().mockResolvedValue({ closed: true, signature: null }),
    checkAndMaybeClose: vi.fn().mockResolvedValue(undefined),
  };
  // `update` mutates the same object `findMany` returns, so a persisted
  // monitoringState/monitoringStateSince/lastMonitoringAlertAt change is
  // actually visible on the next tick() call — a faithful-enough simulation
  // of a real row update for these restart-survival tests.
  const update = vi.fn(
    async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const target = positions.find((p) => (p as { id: string }).id === where.id) as
        Record<string, unknown> | undefined;
      if (target) Object.assign(target, data);
      return target;
    },
  );
  const prisma = {
    position: { findMany: vi.fn().mockResolvedValue(positions), update },
  } as unknown as PrismaClient;
  const dexScreener = {
    getBestSolanaPair: vi.fn().mockResolvedValue({ priceUsd: '1' }),
  } as unknown as DexScreenerClient;

  return {
    prisma,
    dexScreener,
    positionManager: positionManager as unknown as PositionManager,
    logger: fakeLogger(),
    encryptionKey: 'key',
    ...overrides,
    // Cast back so the test helpers below can still inspect the mock calls directly.
  } as PriceMonitorDeps & {
    positionManager: {
      closePosition: ReturnType<typeof vi.fn>;
      checkAndMaybeClose: ReturnType<typeof vi.fn>;
    };
  };
}

describe('PriceMonitor — proactive zero-balance reconciliation (2026-07-21 audit, section E1)', () => {
  it('closes a position whose wallet balance is 0, without waiting for a price-triggered TP/SL', async () => {
    const position = fakePosition();
    const deps = buildDeps({ connection: fakeConnectionWithBalance('0') }, [position]);
    const monitor = new PriceMonitor(deps);

    await monitor.tick();

    expect(deps.positionManager.closePosition).toHaveBeenCalledWith(
      'pos-1',
      'wallet-1',
      'secret',
      'key',
      expect.objectContaining({ reason: 'stop_loss' }),
    );
    // Reconciled before ever reaching normal price-based evaluation.
    expect(deps.positionManager.checkAndMaybeClose).not.toHaveBeenCalled();
    expect(deps.dexScreener.getBestSolanaPair as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it('does not touch a position whose wallet still holds tokens', async () => {
    const position = fakePosition();
    const deps = buildDeps({ connection: fakeConnectionWithBalance('1000000') }, [position]);
    const monitor = new PriceMonitor(deps);

    await monitor.tick();

    expect(deps.positionManager.closePosition).not.toHaveBeenCalled();
    expect(deps.positionManager.checkAndMaybeClose).toHaveBeenCalled();
  });

  it('skips the reconciliation check entirely (falls through to normal processing) when no connection is wired — same optional-dep convention as jupiter/dexRegistry', async () => {
    const position = fakePosition();
    const deps = buildDeps({}, [position]); // connection omitted
    const monitor = new PriceMonitor(deps);

    await monitor.tick();

    expect(deps.positionManager.closePosition).not.toHaveBeenCalled();
    expect(deps.positionManager.checkAndMaybeClose).toHaveBeenCalled();
  });

  it('regression: reconciles the exact "MOODENG"-class incident (DB expects tokens, real balance is 0) without fabricating any PnL input beyond the reference price already on file', async () => {
    const position = fakePosition({ entryPriceUsd: 0.04322, highWaterMarkUsd: 0.04341 });
    const deps = buildDeps({ connection: fakeConnectionWithBalance('0') }, [position]);
    const monitor = new PriceMonitor(deps);

    await monitor.tick();

    const call = deps.positionManager.closePosition.mock.calls[0]!;
    expect(call[4].currentPriceUsd).toBe(0.04341); // uses highWaterMarkUsd, not a fabricated number
  });
});

describe('PriceMonitor — stale/missing price handling (2026-07-21 audit, section E2)', () => {
  it('falls back to a Jupiter reverse-quote when DexScreener returns no price at all, and still evaluates the exit normally', async () => {
    const position = fakePosition(); // entryPriceUsd/highWaterMarkUsd = 1
    // probeJupiterReversePrice quotes 1% of a 10^6-decimals token's raw unit
    // (10000 raw = 0.01 tokens) — sized here so the derived USD price lands
    // close to the position's reference price ($1), i.e. a plausible tick,
    // not an outlier: (66667/1e9 SOL * $150/SOL) / 0.01 tokens ≈ $1.00.
    const jupiter = {
      getQuote: vi.fn().mockResolvedValue({ outAmount: '66667' }),
    } as unknown as JupiterClient;
    const deps = buildDeps(
      {
        dexScreener: {
          getBestSolanaPair: vi.fn().mockResolvedValue(undefined),
        } as unknown as DexScreenerClient,
        jupiter,
      },
      [position],
    );
    const monitor = new PriceMonitor(deps);

    await monitor.tick();

    expect(jupiter.getQuote).toHaveBeenCalled();
    expect(deps.positionManager.checkAndMaybeClose).toHaveBeenCalled();
  });

  it('skips the tick (as before) when DexScreener has nothing and no Jupiter fallback is available either', async () => {
    const position = fakePosition();
    const deps = buildDeps(
      {
        dexScreener: {
          getBestSolanaPair: vi.fn().mockResolvedValue(undefined),
        } as unknown as DexScreenerClient,
      },
      [position],
    );
    const monitor = new PriceMonitor(deps);

    await monitor.tick();

    expect(deps.positionManager.checkAndMaybeClose).not.toHaveBeenCalled();
  });

  it('fires exactly one deduped stale-price alert after the alert threshold, not one per tick', async () => {
    const position = fakePosition({
      monitoringState: 'PRICE_UNAVAILABLE',
      monitoringStateSince: new Date(Date.now() - 20 * 60 * 1000),
    });
    const notifyError = vi.fn().mockResolvedValue(undefined);
    const deps = buildDeps(
      {
        dexScreener: {
          getBestSolanaPair: vi.fn().mockResolvedValue(undefined),
        } as unknown as DexScreenerClient,
        notifier: { notifyError } as never,
      },
      [position],
    );
    const monitor = new PriceMonitor(deps);

    await monitor.tick();
    await monitor.tick();
    await monitor.tick();

    expect(notifyError).toHaveBeenCalledTimes(1);
  });
});

describe('PriceMonitor — persisted monitoring state survives a process restart (2026-07-22 audit)', () => {
  it('production incident: computes elapsed time from the persisted monitoringStateSince, not from zero, across a brand-new PriceMonitor instance (simulating a PM2/process restart)', async () => {
    // Simulates exactly the reported bug: this position has genuinely been
    // priceless for 70 minutes (already recorded on the row from a prior
    // process's ticks), then the process restarts (a fresh PriceMonitor
    // instance, with empty in-memory Maps) — the very first tick on the new
    // instance must still report ~70 minutes elapsed, never "10 minutes."
    const position = fakePosition({
      monitoringState: 'PRICE_UNAVAILABLE',
      monitoringStateSince: new Date(Date.now() - 70 * 60 * 1000),
      lastMonitoringAlertAt: new Date(Date.now() - 60 * 60 * 1000),
      lastAlertedMonitoringState: 'PRICE_UNAVAILABLE',
    });
    const notifyError = vi.fn().mockResolvedValue(undefined);
    const deps = buildDeps(
      {
        dexScreener: {
          getBestSolanaPair: vi.fn().mockResolvedValue(undefined),
        } as unknown as DexScreenerClient,
        notifier: { notifyError } as never,
      },
      [position],
    );

    // A brand-new instance — no in-memory state carried over at all.
    const monitorAfterRestart = new PriceMonitor(deps);
    await monitorAfterRestart.tick();

    // Same state as last alerted, reminder interval (24h default) not yet
    // elapsed since the last alert 60 minutes ago — correctly deduped, not
    // re-alerted as if this were a brand-new ~10-minute episode.
    expect(notifyError).not.toHaveBeenCalled();
    expect(
      (position as { monitoringStateSince: Date | null }).monitoringStateSince!.getTime(),
    ).toBe(Date.now() - 70 * 60 * 1000);
  });

  it('escalates to MANUAL_REVIEW once NO_SELL_ROUTE has persisted past manualReviewAfterMs, without closing the position', async () => {
    const position = fakePosition({
      monitoringState: 'NO_SELL_ROUTE',
      monitoringStateSince: new Date(Date.now() - 25 * 60 * 60 * 1000), // 25h ago
      lastMonitoringAlertAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
      lastAlertedMonitoringState: 'NO_SELL_ROUTE',
    });
    const notifyError = vi.fn().mockResolvedValue(undefined);
    // A confirmed, non-transient "no route" Jupiter response.
    const jupiter = {
      getQuote: vi.fn().mockRejectedValue(new Error('Jupiter quote failed: 400 NO_ROUTES_FOUND')),
    } as unknown as JupiterClient;
    const deps = buildDeps(
      {
        dexScreener: {
          getBestSolanaPair: vi.fn().mockResolvedValue(undefined),
        } as unknown as DexScreenerClient,
        jupiter,
        notifier: { notifyError } as never,
        manualReviewAfterMs: 24 * 60 * 60 * 1000,
      },
      [position],
    );
    const monitor = new PriceMonitor(deps);

    await monitor.tick();

    expect((position as { monitoringState: string }).monitoringState).toBe('MANUAL_REVIEW');
    expect(notifyError).toHaveBeenCalledTimes(1);
    expect(notifyError.mock.calls[0]![1]).toContain('manual review');
    expect(deps.positionManager.closePosition).not.toHaveBeenCalled();
  });

  it('re-alerts on a genuine state change (PRICE_UNAVAILABLE -> NO_SELL_ROUTE) even though the reminder interval has not elapsed', async () => {
    const position = fakePosition({
      monitoringState: 'PRICE_UNAVAILABLE',
      monitoringStateSince: new Date(Date.now() - 15 * 60 * 1000),
      lastMonitoringAlertAt: new Date(Date.now() - 5 * 60 * 1000),
      lastAlertedMonitoringState: 'PRICE_UNAVAILABLE',
    });
    const notifyError = vi.fn().mockResolvedValue(undefined);
    const jupiter = {
      getQuote: vi.fn().mockRejectedValue(new Error('Jupiter quote failed: 400 NO_ROUTES_FOUND')),
    } as unknown as JupiterClient;
    const deps = buildDeps(
      {
        dexScreener: {
          getBestSolanaPair: vi.fn().mockResolvedValue(undefined),
        } as unknown as DexScreenerClient,
        jupiter,
        notifier: { notifyError } as never,
      },
      [position],
    );
    const monitor = new PriceMonitor(deps);

    await monitor.tick();

    expect((position as { monitoringState: string }).monitoringState).toBe('NO_SELL_ROUTE');
    expect(notifyError).toHaveBeenCalledTimes(1);
  });

  it('clears monitoringState back to NORMAL and sends a recovery notification once a usable price returns', async () => {
    const position = fakePosition({
      monitoringState: 'NO_SELL_ROUTE',
      monitoringStateSince: new Date(Date.now() - 20 * 60 * 1000),
      lastMonitoringAlertAt: new Date(Date.now() - 15 * 60 * 1000),
      lastAlertedMonitoringState: 'NO_SELL_ROUTE',
    });
    const notifyError = vi.fn().mockResolvedValue(undefined);
    const deps = buildDeps(
      {
        // DexScreener now has a usable price again.
        dexScreener: {
          getBestSolanaPair: vi.fn().mockResolvedValue({ priceUsd: '1' }),
        } as unknown as DexScreenerClient,
        notifier: { notifyError } as never,
      },
      [position],
    );
    const monitor = new PriceMonitor(deps);

    await monitor.tick();

    expect((position as { monitoringState: string }).monitoringState).toBe('NORMAL');
    expect((position as { monitoringStateSince: Date | null }).monitoringStateSince).toBeNull();
    expect(notifyError).toHaveBeenCalledTimes(1);
    expect(notifyError.mock.calls[0]![0]).toBe('stale price feed recovered');
  });
});

describe('PriceMonitor — concurrent position processing (2026-07-23 USOH incident follow-up, requirement #5)', () => {
  it('a slow/stuck position does not delay checkAndMaybeClose for other open positions in the same tick', async () => {
    const slowPosition = fakePosition({ id: 'pos-slow' });
    const fastPosition = fakePosition({ id: 'pos-fast' });

    let slowResolved = false;
    let fastCalledBeforeSlowResolved = false;
    const checkAndMaybeClose = vi.fn(async (positionId: string) => {
      if (positionId === 'pos-slow') {
        // Simulate a position stuck retrying a failed SELL for a while —
        // pre-fix (sequential for-loop), this would have blocked pos-fast
        // from ever being checked until this resolved.
        await new Promise((resolve) => setTimeout(resolve, 50));
        slowResolved = true;
        return;
      }
      if (positionId === 'pos-fast' && !slowResolved) {
        fastCalledBeforeSlowResolved = true;
      }
    });

    const deps = buildDeps({}, [slowPosition, fastPosition]);
    deps.positionManager.checkAndMaybeClose = checkAndMaybeClose as never;
    const monitor = new PriceMonitor(deps);

    await monitor.tick();

    expect(checkAndMaybeClose).toHaveBeenCalledTimes(2);
    expect(fastCalledBeforeSlowResolved).toBe(true);
  });

  it('one position throwing does not prevent the others from being processed in the same tick', async () => {
    const failingPosition = fakePosition({ id: 'pos-failing' });
    const okPosition = fakePosition({ id: 'pos-ok' });

    const checkAndMaybeClose = vi.fn(async (positionId: string) => {
      if (positionId === 'pos-failing') throw new Error('SELL FAILED [blockhash_expired]');
    });

    const deps = buildDeps({}, [failingPosition, okPosition]);
    deps.positionManager.checkAndMaybeClose = checkAndMaybeClose as never;
    const monitor = new PriceMonitor(deps);

    await monitor.tick();

    expect(checkAndMaybeClose).toHaveBeenCalledWith(
      'pos-ok',
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });
});

describe('PriceMonitor — emergency liquidity-deterioration detection (2026-07-23, requirement #12)', () => {
  it('immediately alerts on a detected liquidity collapse (requirement #9)', async () => {
    const position = fakePosition({
      entryPriceUsd: 1,
      highWaterMarkUsd: 1,
      token: {
        mint: 'ED5nyyWEzpPPiWimP8vYm7sD7TD3LAt3Q3gRTWHzPJBY',
        decimals: 6,
        dex: 'RAYDIUM',
        poolAddress: null,
        symbol: 'ABC',
        liquidityUsd: 700_000,
      },
    });
    const notifyError = vi.fn().mockResolvedValue(undefined);
    const deps = buildDeps(
      {
        dexScreener: {
          getBestSolanaPair: vi
            .fn()
            .mockResolvedValue({ priceUsd: '0.95', liquidity: { usd: 5_000 } }),
        } as unknown as DexScreenerClient,
        notifier: { notifyError } as never,
      },
      [position],
    );
    const monitor = new PriceMonitor(deps);

    await monitor.tick();

    expect(notifyError).toHaveBeenCalledWith(
      'liquidity collapse detected',
      expect.stringContaining('pos-1'),
    );
  });

  it('a real liquidity collapse corroborates an outlier-rejected crash and force-closes via the existing Hard Loss Ceiling path — never an independent forced sell', async () => {
    const position = fakePosition({
      entryPriceUsd: 0.1,
      highWaterMarkUsd: 0.1425,
      stopLossPercent: 20,
      token: {
        mint: 'ED5nyyWEzpPPiWimP8vYm7sD7TD3LAt3Q3gRTWHzPJBY',
        decimals: 6,
        dex: 'RAYDIUM',
        poolAddress: null,
        symbol: 'ABC',
        liquidityUsd: 700_000, // reference — matches Token.liquidityUsd on file
      },
    });
    const deps = buildDeps(
      {
        dexScreener: {
          // Price crashed past the 20x plausibility band AND liquidity
          // collapsed to well under 20% of its reference — both signals
          // agree this is a real crash, not a bad reading.
          getBestSolanaPair: vi
            .fn()
            .mockResolvedValue({ priceUsd: '0.004', liquidity: { usd: 5_000 } }),
        } as unknown as DexScreenerClient,
      },
      [position],
    );
    const monitor = new PriceMonitor(deps);

    await monitor.tick();

    expect(deps.positionManager.closePosition).toHaveBeenCalledWith(
      'pos-1',
      'wallet-1',
      'secret',
      'key',
      expect.objectContaining({ reason: 'stop_loss' }),
    );
  });

  it('does not force an exit from liquidity data alone when the price itself is still plausible — signal only, gated by the existing stop-loss logic', async () => {
    const position = fakePosition({
      entryPriceUsd: 1,
      highWaterMarkUsd: 1,
      stopLossPercent: 20,
      token: {
        mint: 'ED5nyyWEzpPPiWimP8vYm7sD7TD3LAt3Q3gRTWHzPJBY',
        decimals: 6,
        dex: 'RAYDIUM',
        poolAddress: null,
        symbol: 'ABC',
        liquidityUsd: 700_000,
      },
    });
    const deps = buildDeps(
      {
        dexScreener: {
          // Price is within the plausible band (no crash), even though
          // liquidity also happens to have dropped — never enough alone.
          getBestSolanaPair: vi
            .fn()
            .mockResolvedValue({ priceUsd: '0.95', liquidity: { usd: 5_000 } }),
        } as unknown as DexScreenerClient,
      },
      [position],
    );
    const monitor = new PriceMonitor(deps);

    await monitor.tick();

    expect(deps.positionManager.closePosition).not.toHaveBeenCalled();
  });
});
