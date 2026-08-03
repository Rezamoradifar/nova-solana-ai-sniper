import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  isBuyInstruction,
  isCreateInstruction,
  isMigrationInstruction,
  PumpFunMonitor,
  type PumpFunWsProvider,
} from './pumpfun.js';

function fakeLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
}

type OnLogsHandler = (
  logInfo: { err: unknown; logs: string[]; signature: string },
  ctx: { slot: number },
) => void;

function fakeConnection(label: string) {
  let nextId = 1;
  return {
    label,
    onLogs: vi.fn(
      (_programId: unknown, _handler: OnLogsHandler, _commitment?: unknown) => nextId++,
    ),
    removeOnLogsListener: vi.fn().mockResolvedValue(undefined),
  };
}

function providerFrom(fake: ReturnType<typeof fakeConnection>): PumpFunWsProvider {
  return { label: fake.label, connection: fake as never };
}

/** Latest registered onLogs handler for a fake connection (a resubscribe
 * registers a brand-new closure each time). */
function latestHandler(fake: ReturnType<typeof fakeConnection>): OnLogsHandler {
  const calls = fake.onLogs.mock.calls;
  return calls[calls.length - 1]![1] as OnLogsHandler;
}

function deliverRawLog(fake: ReturnType<typeof fakeConnection>, signature: string): void {
  latestHandler(fake)(
    { err: null, logs: ['Program log: Instruction: Buy'], signature },
    { slot: 1 },
  );
}

describe('isCreateInstruction', () => {
  it('matches the plain Create instruction', () => {
    expect(isCreateInstruction(['Program log: Instruction: Create'])).toBe(true);
  });

  it('matches the CreateV2 variant', () => {
    expect(isCreateInstruction(['Program log: Instruction: CreateV2'])).toBe(true);
  });

  it('does not match CreateFeeSharingConfig (verified live: zero token balance movement)', () => {
    expect(isCreateInstruction(['Program log: Instruction: CreateFeeSharingConfig'])).toBe(false);
  });
});

describe('isBuyInstruction', () => {
  it('matches Buy, BuyV2, and BuyExactQuoteInV2', () => {
    expect(isBuyInstruction(['Program log: Instruction: Buy'])).toBe(true);
    expect(isBuyInstruction(['Program log: Instruction: BuyV2'])).toBe(true);
    expect(isBuyInstruction(['Program log: Instruction: BuyExactQuoteInV2'])).toBe(true);
  });

  it('does not match Sell', () => {
    expect(isBuyInstruction(['Program log: Instruction: Sell'])).toBe(false);
  });
});

describe('isMigrationInstruction', () => {
  it('matches a plain Withdraw instruction', () => {
    expect(isMigrationInstruction(['Program log: Instruction: Withdraw'])).toBe(true);
  });

  it('does not match MigrateBondingCurveCreator (verified live: unrelated fee-config admin instruction, zero token balance movement)', () => {
    expect(isMigrationInstruction(['Program log: Instruction: MigrateBondingCurveCreator'])).toBe(
      false,
    );
  });

  it('does not match unrelated logs', () => {
    expect(isMigrationInstruction(['Program log: Instruction: Buy'])).toBe(false);
  });
});

describe('PumpFunMonitor (single provider, basic behavior)', () => {
  it('subscribes exactly once on start', () => {
    const conn = fakeConnection('helius');
    const monitor = new PumpFunMonitor([providerFrom(conn)], fakeLogger());

    monitor.start(() => {});

    expect(conn.onLogs).toHaveBeenCalledTimes(1);
  });

  it('forceResubscribe tears down the old subscription and creates exactly one new one — never a duplicate listener', async () => {
    const conn = fakeConnection('helius');
    const monitor = new PumpFunMonitor([providerFrom(conn)], fakeLogger());
    monitor.start(() => {});

    const firstId = conn.onLogs.mock.results[0]!.value as number;
    await monitor.forceResubscribe();

    expect(conn.removeOnLogsListener).toHaveBeenCalledWith(firstId);
    expect(conn.removeOnLogsListener).toHaveBeenCalledTimes(1);
    expect(conn.onLogs).toHaveBeenCalledTimes(2);
  });

  it('forceResubscribe is a safe no-op before start() has ever run', async () => {
    const conn = fakeConnection('helius');
    const monitor = new PumpFunMonitor([providerFrom(conn)], fakeLogger());

    await monitor.forceResubscribe();

    expect(conn.removeOnLogsListener).not.toHaveBeenCalled();
    expect(conn.onLogs).not.toHaveBeenCalled();
  });

  it('still resubscribes (logged as best-effort) even if removing the old listener itself fails', async () => {
    const conn = fakeConnection('helius');
    conn.removeOnLogsListener.mockRejectedValueOnce(new Error('rpc blip'));
    const logger = fakeLogger();
    const monitor = new PumpFunMonitor([providerFrom(conn)], logger);
    monitor.start(() => {});

    await monitor.forceResubscribe();

    expect(conn.onLogs).toHaveBeenCalledTimes(2);
    expect((logger as unknown as { warn: ReturnType<typeof vi.fn> }).warn).toHaveBeenCalled();
  });

  it('throws if constructed with zero providers', () => {
    expect(() => new PumpFunMonitor([], fakeLogger())).toThrow();
  });
});

describe('PumpFunMonitor (multi-provider watchdog/failover)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reconnect-loop / duplicate-subscription prevention: two concurrent forceResubscribe calls only ever produce one extra subscription', async () => {
    const conn = fakeConnection('helius');
    const monitor = new PumpFunMonitor([providerFrom(conn)], fakeLogger());
    monitor.start(() => {});

    const p1 = monitor.forceResubscribe();
    const p2 = monitor.forceResubscribe();
    await Promise.all([p1, p2]);

    // 1 initial subscribe + 1 resubscribe — the second concurrent call saw
    // the in-flight guard and no-opped, never double-subscribing.
    expect(conn.onLogs).toHaveBeenCalledTimes(2);
    expect(conn.removeOnLogsListener).toHaveBeenCalledTimes(1);
  });

  it('connected-but-no-valid-Create: resubscribes the same provider once, then escalates to a different provider if Creates are STILL silent a full threshold period later', async () => {
    const primary = fakeConnection('helius');
    const backup = fakeConnection('quicknode');
    const logger = fakeLogger();
    const monitor = new PumpFunMonitor([providerFrom(primary), providerFrom(backup)], logger);

    monitor.start(() => {}, {
      watchdogCheckIntervalMs: 1000,
      launchSilenceThresholdMs: 3000,
      watchdogVerifyWindowMs: 500,
    });

    // Raw traffic stays healthy throughout (delivered every tick, well inside
    // the silence threshold) — only genuine Creates are missing, the exact
    // "silently dropping Create notifications" production pattern. A valid
    // Create is never recorded in this test.
    deliverRawLog(primary, 'raw-init');
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(1000);
      deliverRawLog(primary, `raw-a-${i}`);
    }
    await vi.advanceTimersByTimeAsync(1000); // t=4000: createSilentMs=4000>3000 -> first chance: same-provider resubscribe

    expect(primary.onLogs).toHaveBeenCalledTimes(2);
    expect(backup.onLogs).not.toHaveBeenCalled();

    // Keep raw traffic healthy (proving the socket itself is fine) for one
    // more full threshold window with STILL no valid Create — the same-
    // provider resubscribe demonstrably didn't fix anything, so this must
    // escalate to a different provider rather than resubscribing forever.
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(1000);
      deliverRawLog(primary, `raw-b-${i}`);
    }
    await vi.advanceTimersByTimeAsync(1000); // t=8000: createSilentMs=4000>3000 again -> escalate

    expect(backup.onLogs).toHaveBeenCalledTimes(1);
    expect(monitor.getHealth().activeProviderLabel).toBe('quicknode');
    expect(monitor.getHealth().reconnectCount).toBe(2);
  });

  it('hard disconnect (raw traffic itself silent): fails over immediately, skipping the same-provider retry', async () => {
    const primary = fakeConnection('helius');
    const backup = fakeConnection('quicknode');
    const monitor = new PumpFunMonitor([providerFrom(primary), providerFrom(backup)], fakeLogger());

    monitor.start(() => {}, {
      watchdogCheckIntervalMs: 1000,
      launchSilenceThresholdMs: 1500,
      watchdogVerifyWindowMs: 500,
    });

    // No raw traffic at all after start — genuinely dead subscription.
    await vi.advanceTimersByTimeAsync(2000);

    expect(primary.onLogs).toHaveBeenCalledTimes(1); // never retried on itself
    expect(backup.onLogs).toHaveBeenCalledTimes(1);
    expect(monitor.getHealth().activeProviderLabel).toBe('quicknode');
  });

  it('subscribe() throwing synchronously fails over immediately instead of leaving the monitor unsubscribed', async () => {
    const primary = fakeConnection('helius');
    primary.onLogs.mockImplementationOnce(() => {
      throw new Error('socket not ready');
    });
    const backup = fakeConnection('quicknode');
    const monitor = new PumpFunMonitor([providerFrom(primary), providerFrom(backup)], fakeLogger());

    monitor.start(() => {});
    await vi.advanceTimersByTimeAsync(0);

    expect(backup.onLogs).toHaveBeenCalledTimes(1);
    expect(monitor.getHealth().activeProviderLabel).toBe('quicknode');
  });

  it('provider failure applies a bounded cooldown: all-providers-on-cooldown is reported, never a permanent lockout', async () => {
    const only = fakeConnection('helius');
    const monitor = new PumpFunMonitor([providerFrom(only)], fakeLogger());

    monitor.start(() => {}, {
      watchdogCheckIntervalMs: 1000,
      launchSilenceThresholdMs: 1500,
      watchdogVerifyWindowMs: 500,
      providerCooldownBaseMs: 1000,
      providerCooldownMaxMs: 5000,
    });

    await vi.advanceTimersByTimeAsync(2000); // hard raw silence -> failover attempt (only provider available)

    expect(monitor.getHealth().allProvidersOnCooldown).toBe(true);
    // With only one provider, the monitor still keeps retrying it (last
    // resort) rather than refusing to ever reconnect again.
    expect(only.onLogs.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('periodically probes whether the primary has recovered and switches back once verified', async () => {
    const primary = fakeConnection('helius');
    const backup = fakeConnection('quicknode');
    const monitor = new PumpFunMonitor([providerFrom(primary), providerFrom(backup)], fakeLogger());

    monitor.start(() => {}, {
      watchdogCheckIntervalMs: 1000,
      launchSilenceThresholdMs: 1500,
      watchdogVerifyWindowMs: 500,
      providerCooldownBaseMs: 800,
      providerCooldownMaxMs: 5000,
      primaryRecoveryProbeIntervalMs: 1200,
    });

    // Force a failover onto backup via hard raw silence (t=2000).
    await vi.advanceTimersByTimeAsync(2000);
    expect(monitor.getHealth().activeProviderLabel).toBe('quicknode');

    // Confirm THIS failover within its own verify window (t=2500) so it
    // doesn't bounce back to primary prematurely — a real gap (not the same
    // instant) is required, since verification checks a STRICTLY-later event.
    await vi.advanceTimersByTimeAsync(10);
    deliverRawLog(backup, 'backup-verify');

    // Advance to exactly when the recovery probe fires (primaryRecoveryProbeIntervalMs
    // is 1200, and primary's cooldown — applied at t=2000 — always expires
    // well before t=3600 regardless of jitter): 10 + 1590 = 1600ms since the
    // t=2000 failover, i.e. t=3600.
    await vi.advanceTimersByTimeAsync(1590);

    expect(primary.onLogs).toHaveBeenCalledTimes(2); // initial + recovery-probe resubscribe
    expect(monitor.getHealth().activeProviderLabel).toBe('helius');

    // Confirm THIS switch within its own verify window before it elapses.
    await vi.advanceTimersByTimeAsync(10);
    deliverRawLog(primary, 'primary-recovered');
    await vi.advanceTimersByTimeAsync(600);

    expect(monitor.getHealth().activeProviderLabel).toBe('helius');
    expect(primary.onLogs).toHaveBeenCalledTimes(2); // verified — no bounce back
  });
});
