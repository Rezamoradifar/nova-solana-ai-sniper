import { describe, expect, it, vi } from 'vitest';
import { ScannerHealthCoordinator } from './scannerHealth.js';
import type { PumpFunHealthSnapshot } from '../solana/pumpfun.js';
import type { ActiveScanResult, FallbackHealthSnapshot } from './fallbackLaunchDiscovery.js';

function fakeLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
}

function fakePumpFunMonitor(initialHealthy: boolean) {
  let activeProviderHealthy = initialHealthy;
  return {
    getHealth: vi.fn((): PumpFunHealthSnapshot => ({
      activeProviderLabel: 'helius',
      activeProviderIndex: 0,
      providerCount: 1,
      lastRawEventAt: undefined,
      lastValidCreateAt: undefined,
      lastSubscribedAt: undefined,
      reconnectCount: 0,
      consecutiveFailures: 0,
      activeProviderHealthy,
      allProvidersOnCooldown: false,
    })),
    setHealthy(v: boolean) {
      activeProviderHealthy = v;
    },
  };
}

function fakeFallbackDiscovery(initialReachable: boolean) {
  let reachable = initialReachable;
  let active = false;
  let reconciliationResult: ActiveScanResult = {
    signaturesScanned: 0,
    candidatesFound: 0,
    duplicatesRejected: 0,
  };
  let reconciliationDeferred: { resolve: (r: ActiveScanResult) => void } | undefined;

  return {
    getHealth: vi.fn((): FallbackHealthSnapshot => ({
      lastIdleTickAt: Date.now(),
      lastActiveScanAt: undefined,
      lastActiveScanCompletedAt: undefined,
      consecutiveFailures: 0,
      reachable,
      fallbackModeActive: active,
    })),
    setReachable(v: boolean) {
      reachable = v;
    },
    startFallbackMode: vi.fn(() => {
      active = true;
    }),
    stopFallbackMode: vi.fn(() => {
      active = false;
    }),
    get fallbackModeActive() {
      return active;
    },
    runReconciliation: vi.fn(
      () =>
        new Promise<ActiveScanResult>((resolve) => {
          reconciliationDeferred = { resolve };
        }),
    ),
    setReconciliationResult(r: ActiveScanResult) {
      reconciliationResult = r;
    },
    resolveReconciliation() {
      reconciliationDeferred?.resolve(reconciliationResult);
      reconciliationDeferred = undefined;
    },
  };
}

function fakeRedis() {
  return {
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
    get: vi.fn().mockResolvedValue(null),
  };
}

function fakeNotifier() {
  return { notifyError: vi.fn().mockResolvedValue(undefined) };
}

describe('ScannerHealthCoordinator', () => {
  it('stays HEALTHY and sends no alert while the WS source is healthy', async () => {
    const pumpFunMonitor = fakePumpFunMonitor(true);
    const fallbackDiscovery = fakeFallbackDiscovery(true);
    const notifier = fakeNotifier();
    const coordinator = new ScannerHealthCoordinator({
      pumpFunMonitor: pumpFunMonitor as never,
      fallbackDiscovery: fallbackDiscovery as never,
      redis: fakeRedis() as never,
      logger: fakeLogger(),
      notifier: notifier as never,
    });

    await coordinator.tick();
    await coordinator.tick();

    expect(coordinator.getState()).toBe('HEALTHY');
    expect(notifier.notifyError).not.toHaveBeenCalled();
    expect(fallbackDiscovery.startFallbackMode).not.toHaveBeenCalled();
  });

  it('HEALTHY -> DEGRADED when WS is unhealthy but fallback is reachable; auto-buy is NOT paused', async () => {
    const pumpFunMonitor = fakePumpFunMonitor(false);
    const fallbackDiscovery = fakeFallbackDiscovery(true);
    const notifier = fakeNotifier();
    const redis = fakeRedis();
    const coordinator = new ScannerHealthCoordinator({
      pumpFunMonitor: pumpFunMonitor as never,
      fallbackDiscovery: fallbackDiscovery as never,
      redis: redis as never,
      logger: fakeLogger(),
      notifier: notifier as never,
    });

    await coordinator.tick();

    expect(coordinator.getState()).toBe('DEGRADED');
    expect(notifier.notifyError).toHaveBeenCalledTimes(1);
    expect(fallbackDiscovery.startFallbackMode).toHaveBeenCalled();
    // Auto-buy pause is only ever set on UNHEALTHY, never on DEGRADED.
    expect(redis.set).not.toHaveBeenCalledWith(
      expect.stringContaining('scanner_autobuy_paused'),
      '1',
    );
  });

  it('DEGRADED -> UNHEALTHY when the fallback path also fails; sets the auto-buy pause flag', async () => {
    const pumpFunMonitor = fakePumpFunMonitor(false);
    const fallbackDiscovery = fakeFallbackDiscovery(true);
    const notifier = fakeNotifier();
    const redis = fakeRedis();
    const coordinator = new ScannerHealthCoordinator({
      pumpFunMonitor: pumpFunMonitor as never,
      fallbackDiscovery: fallbackDiscovery as never,
      redis: redis as never,
      logger: fakeLogger(),
      notifier: notifier as never,
    });

    await coordinator.tick(); // -> DEGRADED
    fallbackDiscovery.setReachable(false);
    await coordinator.tick(); // -> UNHEALTHY

    expect(coordinator.getState()).toBe('UNHEALTHY');
    expect(redis.set).toHaveBeenCalledWith(expect.stringContaining('scanner_autobuy_paused'), '1');
    expect(notifier.notifyError).toHaveBeenCalledTimes(2);
    const lastAlert = notifier.notifyError.mock.calls.at(-1)![1] as string;
    expect(lastAlert).toContain('PAUSED');
  });

  it('never repeats an alert while the state is unchanged (no duplicate-tick spam)', async () => {
    const pumpFunMonitor = fakePumpFunMonitor(false);
    const fallbackDiscovery = fakeFallbackDiscovery(false);
    const notifier = fakeNotifier();
    const coordinator = new ScannerHealthCoordinator({
      pumpFunMonitor: pumpFunMonitor as never,
      fallbackDiscovery: fallbackDiscovery as never,
      redis: fakeRedis() as never,
      logger: fakeLogger(),
      notifier: notifier as never,
    });

    await coordinator.tick(); // -> UNHEALTHY, 1 alert
    await coordinator.tick();
    await coordinator.tick();

    expect(coordinator.getState()).toBe('UNHEALTHY');
    expect(notifier.notifyError).toHaveBeenCalledTimes(1);
  });

  it('UNHEALTHY -> RECOVERING -> HEALTHY once the WS source recovers and reconciliation completes; pause is NOT auto-cleared by default', async () => {
    const pumpFunMonitor = fakePumpFunMonitor(false);
    const fallbackDiscovery = fakeFallbackDiscovery(false);
    const notifier = fakeNotifier();
    const redis = fakeRedis();
    const coordinator = new ScannerHealthCoordinator({
      pumpFunMonitor: pumpFunMonitor as never,
      fallbackDiscovery: fallbackDiscovery as never,
      redis: redis as never,
      logger: fakeLogger(),
      notifier: notifier as never,
    });

    await coordinator.tick(); // -> UNHEALTHY
    expect(coordinator.getState()).toBe('UNHEALTHY');

    pumpFunMonitor.setHealthy(true);
    await coordinator.tick(); // -> RECOVERING, kicks off reconciliation
    expect(coordinator.getState()).toBe('RECOVERING');
    expect(fallbackDiscovery.runReconciliation).toHaveBeenCalledTimes(1);

    fallbackDiscovery.setReconciliationResult({
      signaturesScanned: 42,
      candidatesFound: 2,
      duplicatesRejected: 1,
    });
    fallbackDiscovery.resolveReconciliation();
    await Promise.resolve(); // let the .then() callback run
    await Promise.resolve();

    await coordinator.tick(); // reconciliationDone is now true -> HEALTHY
    expect(coordinator.getState()).toBe('HEALTHY');

    // Default policy: recovering to HEALTHY does NOT clear the pause flag —
    // only ever set to '1' (on UNHEALTHY), never explicitly cleared to '0'.
    const clearCalls = redis.set.mock.calls.filter(
      ([key, value]) => String(key).includes('scanner_autobuy_paused') && value === '0',
    );
    expect(clearCalls).toHaveLength(0);

    const finalAlert = notifier.notifyError.mock.calls.at(-1)![1] as string;
    expect(finalAlert).toContain('candidate(s)');
  });

  it('auto-clears the pause flag on reaching HEALTHY when autoBuyAutoResumeEnabled is set', async () => {
    const pumpFunMonitor = fakePumpFunMonitor(false);
    const fallbackDiscovery = fakeFallbackDiscovery(false);
    const redis = fakeRedis();
    const coordinator = new ScannerHealthCoordinator(
      {
        pumpFunMonitor: pumpFunMonitor as never,
        fallbackDiscovery: fallbackDiscovery as never,
        redis: redis as never,
        logger: fakeLogger(),
        notifier: fakeNotifier() as never,
      },
      { autoBuyAutoResumeEnabled: true },
    );

    await coordinator.tick(); // -> UNHEALTHY
    pumpFunMonitor.setHealthy(true);
    await coordinator.tick(); // -> RECOVERING
    fallbackDiscovery.resolveReconciliation();
    await Promise.resolve();
    await Promise.resolve();
    await coordinator.tick(); // -> HEALTHY

    expect(coordinator.getState()).toBe('HEALTHY');
    expect(redis.set).toHaveBeenCalledWith(expect.stringContaining('scanner_autobuy_paused'), '0');
  });

  function storeRedis(initial: Record<string, string>) {
    const store = new Map(Object.entries(initial));
    return {
      store,
      get: vi.fn(async (k: string) => store.get(k) ?? null),
      set: vi.fn(async (k: string, v: string) => {
        store.set(k, v);
        return 'OK';
      }),
      del: vi.fn(async (k: string) => {
        store.delete(k);
        return 1;
      }),
    };
  }

  it('clears a stale automatic pause (e.g. from before a restart) while steadily HEALTHY', async () => {
    const redis = storeRedis({
      'nova:trading:scanner_autobuy_paused': '1',
      'nova:trading:scanner_autobuy_paused_reason': 'all launch-detection sources unhealthy',
    });
    const coordinator = new ScannerHealthCoordinator(
      {
        pumpFunMonitor: fakePumpFunMonitor(true) as never,
        fallbackDiscovery: fakeFallbackDiscovery(true) as never,
        redis: redis as never,
        logger: fakeLogger(),
        notifier: fakeNotifier() as never,
      },
      { autoBuyAutoResumeEnabled: true },
    );

    await coordinator.tick();

    expect(redis.store.get('nova:trading:scanner_autobuy_paused')).toBe('0');
  });

  it('keeps a manual admin pause while steadily HEALTHY', async () => {
    const redis = storeRedis({
      'nova:trading:scanner_autobuy_paused': '1',
      'nova:trading:scanner_autobuy_paused_reason': 'manually paused by admin',
    });
    const coordinator = new ScannerHealthCoordinator(
      {
        pumpFunMonitor: fakePumpFunMonitor(true) as never,
        fallbackDiscovery: fakeFallbackDiscovery(true) as never,
        redis: redis as never,
        logger: fakeLogger(),
        notifier: fakeNotifier() as never,
      },
      { autoBuyAutoResumeEnabled: true },
    );

    await coordinator.tick();

    expect(redis.store.get('nova:trading:scanner_autobuy_paused')).toBe('1');
  });

  it('promotes RECOVERING to HEALTHY once the ceiling elapses even if reconciliation never resolves', async () => {
    vi.useFakeTimers();
    try {
      const pumpFunMonitor = fakePumpFunMonitor(false);
      const fallbackDiscovery = fakeFallbackDiscovery(false);
      const coordinator = new ScannerHealthCoordinator(
        {
          pumpFunMonitor: pumpFunMonitor as never,
          fallbackDiscovery: fallbackDiscovery as never,
          redis: fakeRedis() as never,
          logger: fakeLogger(),
          notifier: fakeNotifier() as never,
        },
        { recoveringCeilingMs: 1000 },
      );

      await coordinator.tick(); // -> UNHEALTHY
      pumpFunMonitor.setHealthy(true);
      await coordinator.tick(); // -> RECOVERING (reconciliation never resolves)
      expect(coordinator.getState()).toBe('RECOVERING');

      vi.advanceTimersByTime(1500);
      await coordinator.tick(); // ceiling elapsed -> HEALTHY anyway

      expect(coordinator.getState()).toBe('HEALTHY');
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops fallback mode once HEALTHY and starts it whenever not HEALTHY', async () => {
    const pumpFunMonitor = fakePumpFunMonitor(false);
    const fallbackDiscovery = fakeFallbackDiscovery(true);
    const coordinator = new ScannerHealthCoordinator({
      pumpFunMonitor: pumpFunMonitor as never,
      fallbackDiscovery: fallbackDiscovery as never,
      redis: fakeRedis() as never,
      logger: fakeLogger(),
      notifier: fakeNotifier() as never,
    });

    await coordinator.tick(); // DEGRADED
    expect(fallbackDiscovery.fallbackModeActive).toBe(true);

    pumpFunMonitor.setHealthy(true);
    await coordinator.tick(); // RECOVERING
    fallbackDiscovery.resolveReconciliation();
    await Promise.resolve();
    await Promise.resolve();
    await coordinator.tick(); // HEALTHY

    expect(fallbackDiscovery.fallbackModeActive).toBe(false);
    expect(fallbackDiscovery.stopFallbackMode).toHaveBeenCalled();
  });
});
