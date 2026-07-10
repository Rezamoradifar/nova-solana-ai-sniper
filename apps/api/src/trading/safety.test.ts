import { describe, expect, it, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import {
  evaluateKillSwitch,
  evaluatePerTradeLimit,
  evaluateDailyLossLimit,
  evaluateMaxOpenPositions,
  evaluateWalletBalance,
  evaluateSafetyConfig,
  verifySafetySystemReady,
  TradingSafety,
  type SafetyConfig,
} from './safety.js';

const VALID_PUBKEY = Keypair.generate().publicKey.toBase58();

const BASE_CONFIG: SafetyConfig = {
  maxTradeSol: 1,
  maxDailyLossUsd: 50,
  maxOpenPositions: 5,
  minWalletReserveSol: 0.01,
  killSwitchEnv: false,
};

describe('evaluateKillSwitch', () => {
  it('blocks when active', () => {
    expect(evaluateKillSwitch(true).allowed).toBe(false);
  });
  it('allows when inactive', () => {
    expect(evaluateKillSwitch(false).allowed).toBe(true);
  });
});

describe('evaluatePerTradeLimit', () => {
  it('allows a trade at or below the limit', () => {
    expect(evaluatePerTradeLimit(1, 1).allowed).toBe(true);
    expect(evaluatePerTradeLimit(0.5, 1).allowed).toBe(true);
  });
  it('blocks a trade above the limit', () => {
    const result = evaluatePerTradeLimit(1.01, 1);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/exceeds/);
  });
});

describe('evaluateDailyLossLimit', () => {
  it('allows when losses are within the limit', () => {
    expect(evaluateDailyLossLimit(-49, 50).allowed).toBe(true);
    expect(evaluateDailyLossLimit(10, 50).allowed).toBe(true);
  });
  it('blocks exactly at the limit', () => {
    expect(evaluateDailyLossLimit(-50, 50).allowed).toBe(false);
  });
  it('blocks beyond the limit', () => {
    expect(evaluateDailyLossLimit(-75, 50).allowed).toBe(false);
  });
});

describe('evaluateMaxOpenPositions', () => {
  it('allows below the max', () => {
    expect(evaluateMaxOpenPositions(4, 5).allowed).toBe(true);
  });
  it('blocks at the max', () => {
    expect(evaluateMaxOpenPositions(5, 5).allowed).toBe(false);
  });
});

describe('evaluateWalletBalance', () => {
  it('allows sufficient balance', () => {
    expect(evaluateWalletBalance(2, 1, 0.01).allowed).toBe(true);
  });
  it('blocks when balance is below trade + reserve', () => {
    const result = evaluateWalletBalance(1.005, 1, 0.01);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/below/);
  });
});

describe('evaluateSafetyConfig', () => {
  it('accepts a sane config', () => {
    expect(evaluateSafetyConfig(BASE_CONFIG)).toEqual([]);
  });
  it('flags a non-positive per-trade limit', () => {
    expect(evaluateSafetyConfig({ ...BASE_CONFIG, maxTradeSol: 0 })).toContain(
      'MAX_TRADE_SOL must be a positive number',
    );
  });
  it('flags a non-integer max open positions', () => {
    expect(evaluateSafetyConfig({ ...BASE_CONFIG, maxOpenPositions: 1.5 }).length).toBeGreaterThan(
      0,
    );
  });
  it('flags a negative wallet reserve', () => {
    expect(
      evaluateSafetyConfig({ ...BASE_CONFIG, minWalletReserveSol: -1 }).length,
    ).toBeGreaterThan(0);
  });
});

describe('verifySafetySystemReady', () => {
  it('is ready when config is sane and redis responds', async () => {
    const redis = { ping: vi.fn().mockResolvedValue('PONG') };
    const result = await verifySafetySystemReady(BASE_CONFIG, redis as never);
    expect(result.ready).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('is not ready when redis is unreachable', async () => {
    const redis = { ping: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) };
    const result = await verifySafetySystemReady(BASE_CONFIG, redis as never);
    expect(result.ready).toBe(false);
    expect(result.errors[0]).toMatch(/Redis is unreachable/);
  });

  it('is not ready when the config itself is invalid', async () => {
    const redis = { ping: vi.fn().mockResolvedValue('PONG') };
    const result = await verifySafetySystemReady(
      { ...BASE_CONFIG, maxTradeSol: -1 },
      redis as never,
    );
    expect(result.ready).toBe(false);
  });
});

const fakeLogger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };

describe('TradingSafety.isKillSwitchActive', () => {
  it('is immediately active when the env override is set, without touching redis', async () => {
    const redis = { get: vi.fn() };
    const safety = new TradingSafety(
      {} as never,
      redis as never,
      {} as never,
      { ...BASE_CONFIG, killSwitchEnv: true },
      fakeLogger as never,
    );
    expect(await safety.isKillSwitchActive()).toBe(true);
    expect(redis.get).not.toHaveBeenCalled();
  });

  it('reflects the redis flag when the env override is off', async () => {
    const redis = { get: vi.fn().mockResolvedValue('1') };
    const safety = new TradingSafety(
      {} as never,
      redis as never,
      {} as never,
      BASE_CONFIG,
      fakeLogger as never,
    );
    expect(await safety.isKillSwitchActive()).toBe(true);
  });

  it('is inactive when redis has no flag set', async () => {
    const redis = { get: vi.fn().mockResolvedValue(null) };
    const safety = new TradingSafety(
      {} as never,
      redis as never,
      {} as never,
      BASE_CONFIG,
      fakeLogger as never,
    );
    expect(await safety.isKillSwitchActive()).toBe(false);
  });

  it('fails CLOSED (treats as active) when redis errors', async () => {
    const redis = { get: vi.fn().mockRejectedValue(new Error('connection lost')) };
    const safety = new TradingSafety(
      {} as never,
      redis as never,
      {} as never,
      BASE_CONFIG,
      fakeLogger as never,
    );
    expect(await safety.isKillSwitchActive()).toBe(true);
  });
});

describe('TradingSafety.checkBeforeOpen orchestration', () => {
  function makeSafety(
    overrides: {
      prisma?: {
        position: { findMany: ReturnType<typeof vi.fn>; count: ReturnType<typeof vi.fn> };
      };
      connection?: { getBalance: ReturnType<typeof vi.fn> };
      config?: Partial<SafetyConfig>;
    } = {},
  ) {
    const prisma = overrides.prisma ?? {
      position: {
        findMany: vi.fn().mockResolvedValue([]),
        count: vi.fn().mockResolvedValue(0),
      },
    };
    const connection = overrides.connection ?? {
      getBalance: vi.fn().mockResolvedValue(2_000_000_000),
    };
    const redis = { get: vi.fn().mockResolvedValue(null) };
    const config = { ...BASE_CONFIG, ...overrides.config };
    return new TradingSafety(
      prisma as never,
      redis as never,
      connection as never,
      config,
      fakeLogger as never,
    );
  }

  it('allows a normal trade with everything healthy', async () => {
    const safety = makeSafety();
    const result = await safety.checkBeforeOpen(
      { userId: 'u1', walletId: 'w1', walletPublicKey: VALID_PUBKEY, amountSol: 0.5 },
      { isLive: true },
    );
    expect(result.allowed).toBe(true);
  });

  it('blocks when the kill switch is active, before checking anything else', async () => {
    const prisma = { position: { findMany: vi.fn(), count: vi.fn() } };
    const safety = makeSafety({ prisma, config: { killSwitchEnv: true } });
    const result = await safety.checkBeforeOpen(
      { userId: 'u1', walletId: 'w1', walletPublicKey: VALID_PUBKEY, amountSol: 0.1 },
      { isLive: true },
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/kill switch/i);
    expect(prisma.position.findMany).not.toHaveBeenCalled();
    expect(prisma.position.count).not.toHaveBeenCalled();
  });

  it('blocks a trade above the per-trade limit', async () => {
    const safety = makeSafety({ config: { maxTradeSol: 0.1 } });
    const result = await safety.checkBeforeOpen(
      { userId: 'u1', walletId: 'w1', walletPublicKey: VALID_PUBKEY, amountSol: 5 },
      { isLive: false },
    );
    expect(result.allowed).toBe(false);
  });

  it('blocks when the daily loss limit has been hit', async () => {
    const prisma = {
      position: {
        findMany: vi.fn().mockResolvedValue([{ realizedPnlUsd: -60 }]),
        count: vi.fn().mockResolvedValue(0),
      },
    };
    const safety = makeSafety({ prisma, config: { maxDailyLossUsd: 50 } });
    const result = await safety.checkBeforeOpen(
      { userId: 'u1', walletId: 'w1', walletPublicKey: VALID_PUBKEY, amountSol: 0.1 },
      { isLive: false },
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/daily loss/i);
  });

  it('blocks when max open positions is reached', async () => {
    const prisma = {
      position: {
        findMany: vi.fn().mockResolvedValue([]),
        count: vi.fn().mockResolvedValue(5),
      },
    };
    const safety = makeSafety({ prisma, config: { maxOpenPositions: 5 } });
    const result = await safety.checkBeforeOpen(
      { userId: 'u1', walletId: 'w1', walletPublicKey: VALID_PUBKEY, amountSol: 0.1 },
      { isLive: false },
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/max open positions/i);
  });

  it('checks wallet balance only when isLive is true', async () => {
    const liveConnection = { getBalance: vi.fn().mockResolvedValue(0) };
    const safetyLive = makeSafety({ connection: liveConnection });
    const liveResult = await safetyLive.checkBeforeOpen(
      { userId: 'u1', walletId: 'w1', walletPublicKey: VALID_PUBKEY, amountSol: 0.5 },
      { isLive: true },
    );
    expect(liveResult.allowed).toBe(false);
    expect(liveConnection.getBalance).toHaveBeenCalled();

    const paperConnection = { getBalance: vi.fn().mockResolvedValue(0) };
    const safetyPaper = makeSafety({ connection: paperConnection });
    const paperResult = await safetyPaper.checkBeforeOpen(
      { userId: 'u1', walletId: 'w1', walletPublicKey: VALID_PUBKEY, amountSol: 0.5 },
      { isLive: false },
    );
    expect(paperResult.allowed).toBe(true);
    expect(paperConnection.getBalance).not.toHaveBeenCalled();
  });
});
