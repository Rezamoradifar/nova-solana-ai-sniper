import { describe, expect, it, vi } from 'vitest';
import {
  isBuyInstruction,
  isCreateInstruction,
  isMigrationInstruction,
  PumpFunMonitor,
} from './pumpfun.js';

function fakeLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
}

function fakeConnection() {
  let nextId = 1;
  return {
    onLogs: vi.fn(() => nextId++),
    removeOnLogsListener: vi.fn().mockResolvedValue(undefined),
  };
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

describe('PumpFunMonitor', () => {
  it('subscribes exactly once on start', () => {
    const connection = fakeConnection();
    const monitor = new PumpFunMonitor(connection as never, fakeLogger());

    monitor.start(() => {});

    expect(connection.onLogs).toHaveBeenCalledTimes(1);
  });

  it('production incident (2026-07-22): forceResubscribe tears down the old subscription and creates exactly one new one — never a duplicate listener', async () => {
    const connection = fakeConnection();
    const monitor = new PumpFunMonitor(connection as never, fakeLogger());
    monitor.start(() => {});

    const firstId = connection.onLogs.mock.results[0]!.value as number;
    await monitor.forceResubscribe();

    expect(connection.removeOnLogsListener).toHaveBeenCalledWith(firstId);
    expect(connection.removeOnLogsListener).toHaveBeenCalledTimes(1);
    expect(connection.onLogs).toHaveBeenCalledTimes(2);
  });

  it('forceResubscribe is a safe no-op before start() has ever run', async () => {
    const connection = fakeConnection();
    const monitor = new PumpFunMonitor(connection as never, fakeLogger());

    await monitor.forceResubscribe();

    expect(connection.removeOnLogsListener).not.toHaveBeenCalled();
    expect(connection.onLogs).not.toHaveBeenCalled();
  });

  it('still resubscribes (logged as best-effort) even if removing the old listener itself fails', async () => {
    const connection = fakeConnection();
    connection.removeOnLogsListener.mockRejectedValueOnce(new Error('rpc blip'));
    const logger = fakeLogger();
    const monitor = new PumpFunMonitor(connection as never, logger);
    monitor.start(() => {});

    await monitor.forceResubscribe();

    expect(connection.onLogs).toHaveBeenCalledTimes(2);
    expect((logger as unknown as { warn: ReturnType<typeof vi.fn> }).warn).toHaveBeenCalled();
  });
});
