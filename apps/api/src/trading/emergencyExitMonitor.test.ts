import { describe, expect, it, vi } from 'vitest';
import { EmergencyExitMonitor } from './emergencyExitMonitor.js';

function fakeLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
}

function basePosition(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pos-1',
    walletId: 'wallet-1',
    status: 'OPEN',
    isPaperTrade: false,
    institutionalModeEnabled: false,
    entryPriceUsd: 1,
    highWaterMarkUsd: 1,
    amountToken: 100,
    remainingAmountToken: 100,
    devWalletAddress: null,
    devWalletAmountRawAtEntry: null,
    sellUnsellable: false,
    token: { mint: 'MintABC', dex: 'PUMPFUN', symbol: 'ABC', poolAddress: null },
    wallet: { encryptedSecret: 'enc-secret' },
    ...overrides,
  };
}

function fakeDeps(positions: ReturnType<typeof basePosition>[]) {
  const findMany = vi.fn().mockResolvedValue(positions);
  const emergencyExitLogCreate = vi.fn().mockResolvedValue(undefined);
  const closePosition = vi.fn().mockResolvedValue({
    signature: 'sig123',
    position: { realizedPnlUsd: -80 },
  });
  const notifyEmergencyExit = vi.fn().mockResolvedValue(undefined);

  const deps = {
    prisma: {
      position: { findMany },
      emergencyExitLog: { create: emergencyExitLogCreate },
    },
    connection: { getTokenAccountBalance: vi.fn() },
    dexScreener: { getBestSolanaPair: vi.fn().mockResolvedValue(undefined) },
    jupiter: { getQuote: vi.fn().mockResolvedValue({}) },
    riskAnalyzer: {
      analyze: vi.fn().mockResolvedValue({
        liquidityUsd: 0,
        mintAuthorityRevoked: true,
        freezeAuthorityRevoked: true,
        isHoneypotSuspected: false,
        top10HolderPercent: 10,
        holderCount: 50,
        liquiditySource: 'dexscreener',
      }),
    },
    positionManager: { closePosition },
    logger: fakeLogger(),
    encryptionKey: 'key',
    notifier: { notifyEmergencyExit },
  } as never;

  return { deps, findMany, closePosition, notifyEmergencyExit, emergencyExitLogCreate };
}

describe('EmergencyExitMonitor.tick', () => {
  it('queries every OPEN, sellable position — not just institutionalModeEnabled ones (2026-07-23 audit)', async () => {
    const { deps, findMany } = fakeDeps([]);
    const monitor = new EmergencyExitMonitor(deps);

    await monitor.tick();

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: 'OPEN', sellUnsellable: false },
      }),
    );
    // Regression guard: the old institutional-only filter must be gone.
    const call = findMany.mock.calls[0]![0] as { where: Record<string, unknown> };
    expect(call.where).not.toHaveProperty('institutionalModeEnabled');
  });

  it('force-closes a non-institutional position on a liquidity-removed rug signal', async () => {
    const position = basePosition({ institutionalModeEnabled: false });
    const { deps, closePosition, notifyEmergencyExit } = fakeDeps([position]);
    const monitor = new EmergencyExitMonitor(deps);

    await monitor.tick();

    expect(closePosition).toHaveBeenCalledTimes(1);
    expect(closePosition).toHaveBeenCalledWith(
      'pos-1',
      'wallet-1',
      'enc-secret',
      'key',
      expect.objectContaining({ reason: 'emergency' }),
    );
    expect(notifyEmergencyExit).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'liquidity_removed' }),
    );
  });

  it('does not touch a healthy position with real liquidity and a working sell route', async () => {
    const position = basePosition();
    const { deps, closePosition } = fakeDeps([position]);
    (deps as { riskAnalyzer: { analyze: ReturnType<typeof vi.fn> } }).riskAnalyzer.analyze = vi
      .fn()
      .mockResolvedValue({
        liquidityUsd: 50_000,
        mintAuthorityRevoked: true,
        freezeAuthorityRevoked: true,
        isHoneypotSuspected: false,
        top10HolderPercent: 10,
        holderCount: 50,
        liquiditySource: 'dexscreener',
      });
    const monitor = new EmergencyExitMonitor(deps);

    await monitor.tick();

    expect(closePosition).not.toHaveBeenCalled();
  });
});
