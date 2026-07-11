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
    user: { wallets: [{ id: 'wallet-1', publicKey: 'Pubkey1', encryptedSecret: 'enc' }] },
    ...overrides,
  };
}

function setup(config: ReturnType<typeof fakeConfig>) {
  const openPosition = vi.fn().mockResolvedValue({ trade: {}, position: {} });
  const prisma = { snipeConfig: { findMany: vi.fn().mockResolvedValue([config]) } } as never;
  const positionManager = { openPosition } as never;
  const trader = new AutoTrader({
    prisma,
    riskAnalyzer: {} as never,
    positionManager,
    logger: fakeLogger(),
    encryptionKey: 'key',
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
