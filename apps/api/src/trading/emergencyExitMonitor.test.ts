import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { Connection } from '@solana/web3.js';
import { EmergencyExitMonitor } from './emergencyExitMonitor.js';
import { RiskAnalyzer } from '../detection/riskAnalyzer.js';

function fakePosition(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pos-1',
    walletId: 'wallet-1',
    entryPriceUsd: 0.001,
    highWaterMarkUsd: 0.001,
    remainingAmountToken: 1_000_000,
    amountToken: 1_000_000,
    isPaperTrade: false,
    institutionalModeEnabled: false,
    devWalletAddress: null,
    devWalletAmountRawAtEntry: null,
    token: {
      mint: 'MintAAAA1111111111111111111111111111111111',
      dex: 'PUMPSWAP',
      poolAddress: null,
      symbol: 'TEST',
    },
    wallet: { encryptedSecret: 'enc-secret' },
    ...overrides,
  };
}

function fakeDeps(positions: ReturnType<typeof fakePosition>[]) {
  const positionFindMany = vi.fn().mockResolvedValue(positions);
  const emergencyExitLogCreate = vi.fn().mockResolvedValue({ id: 'log-1' });
  const closePosition = vi.fn().mockResolvedValue({
    signature: 'sig-1',
    position: { realizedPnlUsd: -5 },
  });
  const notifyEmergencyExit = vi.fn().mockResolvedValue(undefined);
  const analyze = vi.fn().mockResolvedValue({
    liquidityUsd: 10_000,
    mintAuthorityRevoked: true,
    freezeAuthorityRevoked: true,
  });
  const getQuote = vi.fn().mockResolvedValue({ outAmount: '1' });
  const getBestSolanaPair = vi.fn().mockResolvedValue({ priceUsd: '0.001' });
  const getTokenAccountBalance = vi.fn().mockResolvedValue({ value: { amount: '0' } });
  const logger = { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() };

  const deps = {
    prisma: {
      position: { findMany: positionFindMany },
      emergencyExitLog: { create: emergencyExitLogCreate },
    } as unknown as PrismaClient,
    connection: { getTokenAccountBalance } as unknown as Connection,
    dexScreener: { getBestSolanaPair } as never,
    jupiter: { getQuote } as never,
    riskAnalyzer: { analyze } as never,
    positionManager: { closePosition } as never,
    logger: logger as never,
    encryptionKey: 'key',
    notifier: { notifyEmergencyExit } as never,
  };

  return {
    deps,
    positionFindMany,
    emergencyExitLogCreate,
    closePosition,
    notifyEmergencyExit,
    analyze,
    getQuote,
    logger,
  };
}

describe('EmergencyExitMonitor — 2026-07-28 scope fix', () => {
  it('queries every OPEN, non-unsellable position — no institutionalModeEnabled filter', async () => {
    const { deps, positionFindMany } = fakeDeps([]);
    const monitor = new EmergencyExitMonitor(deps);

    await monitor.tick();

    expect(positionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: 'OPEN', sellUnsellable: false },
      }),
    );
  });

  it('force-closes a non-institutional position on a real liquidity collapse — previously unreachable', async () => {
    const position = fakePosition({ institutionalModeEnabled: false });
    const { deps, closePosition, emergencyExitLogCreate, notifyEmergencyExit, analyze } = fakeDeps([
      position,
    ]);
    analyze.mockResolvedValue({
      liquidityUsd: 50, // < LIQUIDITY_REMOVED_THRESHOLD_USD (500)
      mintAuthorityRevoked: true,
      freezeAuthorityRevoked: true,
    });
    vi.spyOn(RiskAnalyzer, 'ruleBasedScore').mockReturnValue(90);
    const monitor = new EmergencyExitMonitor(deps);

    await monitor.tick();

    expect(closePosition).toHaveBeenCalledWith(
      position.id,
      position.walletId,
      position.wallet.encryptedSecret,
      deps.encryptionKey,
      expect.objectContaining({ reason: 'emergency' }),
    );
    expect(emergencyExitLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ positionId: position.id, reason: 'liquidity_removed' }),
      }),
    );
    expect(notifyEmergencyExit).toHaveBeenCalled();
  });

  it('does not force-close a healthy non-institutional position', async () => {
    const position = fakePosition({ institutionalModeEnabled: false });
    const { deps, closePosition, analyze } = fakeDeps([position]);
    analyze.mockResolvedValue({
      liquidityUsd: 10_000,
      mintAuthorityRevoked: true,
      freezeAuthorityRevoked: true,
    });
    vi.spyOn(RiskAnalyzer, 'ruleBasedScore').mockReturnValue(90);
    const monitor = new EmergencyExitMonitor(deps);

    await monitor.tick();

    expect(closePosition).not.toHaveBeenCalled();
  });

  it('still protects an institutional-mode position (pre-existing behavior, unaffected by the scope fix)', async () => {
    const position = fakePosition({ institutionalModeEnabled: true });
    const { deps, closePosition, analyze } = fakeDeps([position]);
    analyze.mockResolvedValue({
      liquidityUsd: 50,
      mintAuthorityRevoked: true,
      freezeAuthorityRevoked: true,
    });
    vi.spyOn(RiskAnalyzer, 'ruleBasedScore').mockReturnValue(90);
    const monitor = new EmergencyExitMonitor(deps);

    await monitor.tick();

    expect(closePosition).toHaveBeenCalled();
  });

  it('logs and continues to the next position when one position throws mid-tick', async () => {
    const good = fakePosition({ id: 'pos-good' });
    const bad = fakePosition({ id: 'pos-bad' });
    const { deps, closePosition, analyze, logger } = fakeDeps([bad, good]);
    analyze.mockRejectedValueOnce(new Error('rpc blip')).mockResolvedValueOnce({
      liquidityUsd: 50,
      mintAuthorityRevoked: true,
      freezeAuthorityRevoked: true,
    });
    vi.spyOn(RiskAnalyzer, 'ruleBasedScore').mockReturnValue(90);
    const monitor = new EmergencyExitMonitor(deps);

    await monitor.tick();

    expect(logger.error).toHaveBeenCalled();
    expect(closePosition).toHaveBeenCalledWith(
      'pos-good',
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });
});
