import { describe, expect, it, vi } from 'vitest';
import { AutoTrader } from './autoTrader.js';

function fakeLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
}

const RISK_FLAGS = {
  mintAuthorityRevoked: true,
  freezeAuthorityRevoked: true,
  lpBurnedOrLocked: true,
  top10HolderPercent: 40,
  isHoneypotSuspected: false,
  liquidityUsd: 50_000,
  liquiditySource: 'dexscreener' as const,
};

function fakeConfig(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'config-1',
    userId: 'user-1',
    minLiquidityUsd: 0,
    minAiScore: 0,
    buyAmountSol: 0.1,
    maxSlippageBps: 300,
    takeProfitPercent: 50,
    stopLossPercent: 20,
    trailingStopPercent: 10,
    trailingStopPreset: null,
    entryFilterEnabled: false,
    minBuySellRatio: 0,
    minHolderCount: 0,
    minRecentVolumeUsd: 0,
    maxTop10HolderPercent: 100,
    user: { wallets: [{ id: 'wallet-1', publicKey: 'Pubkey1', encryptedSecret: 'enc' }] },
    ...overrides,
  };
}

function setup(config: ReturnType<typeof fakeConfig>, entryFilterGloballyEnabled = false) {
  const openPosition = vi.fn().mockResolvedValue({ trade: {}, position: {} });
  const prisma = { snipeConfig: { findMany: vi.fn().mockResolvedValue([config]) } } as never;
  const positionManager = { openPosition } as never;
  const trader = new AutoTrader({
    prisma,
    riskAnalyzer: {} as never,
    positionManager,
    logger: fakeLogger(),
    encryptionKey: 'key',
    entryFilterGloballyEnabled,
  });
  return { trader, openPosition };
}

describe('AutoTrader — trailing-stop preset wiring (optional exit strategy)', () => {
  it('passes the manual takeProfit/stopLoss/trailing fields through unchanged when no preset is set (backward compatible default)', async () => {
    const { trader, openPosition } = setup(fakeConfig({ trailingStopPreset: null }));

    await trader.evaluateAndMaybeBuy('MintABC', 'token-1', RISK_FLAGS, 80);

    expect(openPosition).toHaveBeenCalledWith(
      expect.objectContaining({
        takeProfitPercent: 50,
        stopLossPercent: 20,
        trailingStopPercent: 10,
        trailingStopPreset: undefined,
      }),
    );
  });

  it('also passes manual fields through unchanged for an explicit "custom" preset value', async () => {
    const { trader, openPosition } = setup(fakeConfig({ trailingStopPreset: 'custom' }));

    await trader.evaluateAndMaybeBuy('MintABC', 'token-1', RISK_FLAGS, 80);

    expect(openPosition).toHaveBeenCalledWith(
      expect.objectContaining({
        takeProfitPercent: 50,
        stopLossPercent: 20,
        trailingStopPercent: 10,
      }),
    );
  });

  it('overrides with no take-profit cap and the adaptive trailing/stop-loss values for a real preset', async () => {
    const { trader, openPosition } = setup(fakeConfig({ trailingStopPreset: 'meme_coin' }));

    await trader.evaluateAndMaybeBuy('MintABC', 'token-1', RISK_FLAGS, 80);

    expect(openPosition).toHaveBeenCalledWith(
      expect.objectContaining({
        takeProfitPercent: undefined, // no profit cap — requirement #1
        stopLossPercent: 40, // meme_coin base SL
        trailingStopPercent: 30, // meme_coin base trail, mid-range liquidity/concentration -> no adjustment
        trailingStopPreset: 'meme_coin',
      }),
    );
  });

  it('an unrecognized preset string falls back to manual fields, same as null (fails closed, not silently onto a made-up preset)', async () => {
    const { trader, openPosition } = setup(fakeConfig({ trailingStopPreset: 'not_a_real_preset' }));

    await trader.evaluateAndMaybeBuy('MintABC', 'token-1', RISK_FLAGS, 80);

    expect(openPosition).toHaveBeenCalledWith(
      expect.objectContaining({
        takeProfitPercent: 50,
        stopLossPercent: 20,
        trailingStopPercent: 10,
      }),
    );
  });
});

describe('AutoTrader — Smart Entry Filter (opt-in, additive gate)', () => {
  it('never blocks when the global flag is off, even if a config has opted in and would otherwise fail', async () => {
    const { trader, openPosition } = setup(
      fakeConfig({ entryFilterEnabled: true, maxTop10HolderPercent: 10 }),
      false,
    );

    await trader.evaluateAndMaybeBuy('MintABC', 'token-1', RISK_FLAGS, 80);

    expect(openPosition).toHaveBeenCalled();
  });

  it('never blocks when the config itself has not opted in, even if the global flag is on', async () => {
    const { trader, openPosition } = setup(
      fakeConfig({ entryFilterEnabled: false, maxTop10HolderPercent: 10 }),
      true,
    );

    await trader.evaluateAndMaybeBuy('MintABC', 'token-1', RISK_FLAGS, 80);

    expect(openPosition).toHaveBeenCalled();
  });

  it('blocks and skips the buy when both are opted in and a signal fails a configured threshold', async () => {
    const { trader, openPosition } = setup(
      fakeConfig({ entryFilterEnabled: true, maxTop10HolderPercent: 10 }),
      true,
    );

    const results = await trader.evaluateAndMaybeBuy('MintABC', 'token-1', RISK_FLAGS, 80);

    expect(openPosition).not.toHaveBeenCalled();
    expect(results).toEqual([{ userId: 'user-1', bought: false, reason: 'entry_filter_blocked' }]);
  });

  it('allows the buy through when both are opted in and every signal passes', async () => {
    const { trader, openPosition } = setup(fakeConfig({ entryFilterEnabled: true }), true);

    await trader.evaluateAndMaybeBuy('MintABC', 'token-1', RISK_FLAGS, 80);

    expect(openPosition).toHaveBeenCalled();
  });
});
