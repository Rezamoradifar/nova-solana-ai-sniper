import { describe, expect, it, vi } from 'vitest';
import { AutoTrader } from './autoTrader.js';
import { SellabilityCheckError } from './sellabilityCheck.js';
import { SafetyCheckError } from './safety.js';

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
  // Must clear criticalSecurityGate.ts's HARD_MIN_HOLDER_COUNT floor — every
  // test in this file exercises logic *downstream* of that gate, so the
  // shared fixture needs to represent a token the gate would actually pass.
  holderCount: 50,
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
    useOpportunityScoreGate: false,
    user: { wallets: [{ id: 'wallet-1', publicKey: 'Pubkey1', encryptedSecret: 'enc' }] },
    ...overrides,
  };
}

function setup(
  config: ReturnType<typeof fakeConfig>,
  entryFilterGloballyEnabled = false,
  opportunityScoreGateGloballyEnabled = false,
) {
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
    opportunityScoreGateGloballyEnabled,
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

describe('AutoTrader — riskScoreAtEntry persistence (production bug fix 2026-07-18)', () => {
  it('passes riskScoreAtEntry as min(ruleScore, aiScore) — the same value that gated the buy', async () => {
    const { trader, openPosition } = setup(fakeConfig());

    // RISK_FLAGS -> ruleScore 90 (top10HolderPercent=40 is in the >30 band, -10);
    // aiScore passed here is 80, so min(90, 80) = 80.
    await trader.evaluateAndMaybeBuy('MintABC', 'token-1', RISK_FLAGS, 80);

    expect(openPosition).toHaveBeenCalledWith(expect.objectContaining({ riskScoreAtEntry: 80 }));
  });

  it('takes the rule score, not the AI score, when the rule score is the lower of the two', async () => {
    const { trader, openPosition } = setup(fakeConfig());

    // aiScore=95 > ruleScore=90 this time -> min(90, 95) = 90.
    await trader.evaluateAndMaybeBuy('MintABC', 'token-1', RISK_FLAGS, 95);

    expect(openPosition).toHaveBeenCalledWith(expect.objectContaining({ riskScoreAtEntry: 90 }));
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

describe('AutoTrader — Final Opportunity Score gate (Section 7, opt-in, additive)', () => {
  // ruleScore for RISK_FLAGS is 90 (top10HolderPercent 40 > 30 => -10). aiScore
  // 50 makes min(ruleScore, aiScore) = 50, which fails minAiScore=70; a
  // finalOpportunityScore of 85 passes it — the two gates disagree on purpose,
  // so a passing test proves which one actually decided the outcome.
  it('never uses the opportunity score when the global flag is off, even if the config opted in', async () => {
    const { trader, openPosition } = setup(
      fakeConfig({ useOpportunityScoreGate: true, minAiScore: 70 }),
      false,
      false,
    );

    const results = await trader.evaluateAndMaybeBuy(
      'MintABC',
      'token-1',
      RISK_FLAGS,
      50,
      undefined,
      85,
    );

    expect(openPosition).not.toHaveBeenCalled();
    expect(results).toEqual([{ userId: 'user-1', bought: false, reason: 'score_below_threshold' }]);
  });

  it('never uses the opportunity score when the config itself has not opted in, even if the global flag is on', async () => {
    const { trader, openPosition } = setup(
      fakeConfig({ useOpportunityScoreGate: false, minAiScore: 70 }),
      false,
      true,
    );

    const results = await trader.evaluateAndMaybeBuy(
      'MintABC',
      'token-1',
      RISK_FLAGS,
      50,
      undefined,
      85,
    );

    expect(openPosition).not.toHaveBeenCalled();
    expect(results).toEqual([{ userId: 'user-1', bought: false, reason: 'score_below_threshold' }]);
  });

  it('uses the opportunity score instead of min(ruleScore, aiScore) once both are opted in', async () => {
    const { trader, openPosition } = setup(
      fakeConfig({ useOpportunityScoreGate: true, minAiScore: 70 }),
      true,
      true,
    );

    await trader.evaluateAndMaybeBuy('MintABC', 'token-1', RISK_FLAGS, 50, undefined, 85);

    expect(openPosition).toHaveBeenCalled();
  });

  it('can also block a buy the old gate would have allowed, proving the switch runs both ways', async () => {
    const { trader, openPosition } = setup(
      fakeConfig({ useOpportunityScoreGate: true, minAiScore: 70 }),
      true,
      true,
    );

    // min(ruleScore=90, aiScore=95) = 90, which would pass minAiScore=70 —
    // but a low finalOpportunityScore still blocks the buy.
    const results = await trader.evaluateAndMaybeBuy(
      'MintABC',
      'token-1',
      RISK_FLAGS,
      95,
      undefined,
      50,
    );

    expect(openPosition).not.toHaveBeenCalled();
    expect(results).toEqual([{ userId: 'user-1', bought: false, reason: 'score_below_threshold' }]);
  });

  it('falls back to min(ruleScore, aiScore) when no opportunity score was computed upstream, even with both flags on', async () => {
    const { trader, openPosition } = setup(
      fakeConfig({ useOpportunityScoreGate: true, minAiScore: 70 }),
      true,
      true,
    );

    // finalOpportunityScore omitted entirely (undefined) — min(90, 95) = 90 passes.
    await trader.evaluateAndMaybeBuy('MintABC', 'token-1', RISK_FLAGS, 95);

    expect(openPosition).toHaveBeenCalled();
  });
});

describe('AutoTrader — root-cause investigation 2026-07-12: an accepted token can never be silently skipped', () => {
  it('every config always gets exactly one result — never fewer than configs.length', async () => {
    const { trader } = setup(fakeConfig({ minLiquidityUsd: 1_000_000 })); // fails the liquidity gate

    const results = await trader.evaluateAndMaybeBuy('MintABC', 'token-1', RISK_FLAGS, 80);

    expect(results).toHaveLength(1);
    expect(results[0]!.bought).toBe(false);
    expect(results[0]!.reason).toBeDefined();
  });

  it('logs a structured BUY CANCELLED line with an explicit reason for the liquidity gate', async () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const openPosition = vi.fn().mockResolvedValue({ trade: {}, position: {} });
    const config = fakeConfig({ minLiquidityUsd: 1_000_000 });
    const prisma = { snipeConfig: { findMany: vi.fn().mockResolvedValue([config]) } } as never;
    const trader = new AutoTrader({
      prisma,
      riskAnalyzer: {} as never,
      positionManager: { openPosition } as never,
      logger: logger as never,
      encryptionKey: 'key',
    });

    await trader.evaluateAndMaybeBuy('MintABC', 'token-1', RISK_FLAGS, 80);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        mint: 'MintABC',
        userId: 'user-1',
        location: expect.stringContaining('autoTrader.ts'),
      }),
      expect.stringMatching(/^BUY CANCELLED\nReason:\nliquidity_below_threshold/),
    );
  });

  it('logs a structured BUY CANCELLED line with an explicit reason for the score gate', async () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const openPosition = vi.fn().mockResolvedValue({ trade: {}, position: {} });
    const config = fakeConfig({ minAiScore: 999 });
    const prisma = { snipeConfig: { findMany: vi.fn().mockResolvedValue([config]) } } as never;
    const trader = new AutoTrader({
      prisma,
      riskAnalyzer: {} as never,
      positionManager: { openPosition } as never,
      logger: logger as never,
      encryptionKey: 'key',
    });

    await trader.evaluateAndMaybeBuy('MintABC', 'token-1', RISK_FLAGS, 80);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ mint: 'MintABC', userId: 'user-1' }),
      expect.stringMatching(/^BUY CANCELLED\nReason:\nscore_below_threshold/),
    );
  });

  it('logs a structured BUY CANCELLED line when the user has no active wallet', async () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const openPosition = vi.fn().mockResolvedValue({ trade: {}, position: {} });
    const config = fakeConfig({ user: { wallets: [] } });
    const prisma = { snipeConfig: { findMany: vi.fn().mockResolvedValue([config]) } } as never;
    const trader = new AutoTrader({
      prisma,
      riskAnalyzer: {} as never,
      positionManager: { openPosition } as never,
      logger: logger as never,
      encryptionKey: 'key',
    });

    const results = await trader.evaluateAndMaybeBuy('MintABC', 'token-1', RISK_FLAGS, 80);

    expect(results).toEqual([{ userId: 'user-1', bought: false, reason: 'no_active_wallet' }]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringMatching(/^BUY CANCELLED\nReason:\nno_active_wallet/),
    );
  });

  it('logs BUY STARTED and BUY EXECUTED with the real signature when the buy succeeds', async () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const openPosition = vi
      .fn()
      .mockResolvedValue({ trade: { txSignature: 'sig-abc-123' }, position: {} });
    const config = fakeConfig();
    const prisma = { snipeConfig: { findMany: vi.fn().mockResolvedValue([config]) } } as never;
    const trader = new AutoTrader({
      prisma,
      riskAnalyzer: {} as never,
      positionManager: { openPosition } as never,
      logger: logger as never,
      encryptionKey: 'key',
    });

    const results = await trader.evaluateAndMaybeBuy('MintABC', 'token-1', RISK_FLAGS, 80);

    expect(results).toEqual([{ userId: 'user-1', bought: true }]);
    expect(logger.info).toHaveBeenCalledWith(expect.anything(), 'BUY STARTED');
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ signature: 'sig-abc-123' }),
      'BUY EXECUTED\nSignature:\nsig-abc-123',
    );
  });

  it('a generic execution error still produces a result with a reason and a structured BUY CANCELLED log, never a silent skip', async () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const openPosition = vi.fn().mockRejectedValue(new Error('RPC timeout'));
    const config = fakeConfig();
    const prisma = { snipeConfig: { findMany: vi.fn().mockResolvedValue([config]) } } as never;
    const trader = new AutoTrader({
      prisma,
      riskAnalyzer: {} as never,
      positionManager: { openPosition } as never,
      logger: logger as never,
      encryptionKey: 'key',
    });

    const results = await trader.evaluateAndMaybeBuy('MintABC', 'token-1', RISK_FLAGS, 80);

    expect(results).toEqual([{ userId: 'user-1', bought: false, reason: 'execution_error' }]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.stringMatching(/^BUY CANCELLED\nReason:\nexecution_error: RPC timeout/),
    );
  });

  it('logs TOKEN ACCEPTED at info level (visible in production) even when there are zero active configs', async () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const prisma = { snipeConfig: { findMany: vi.fn().mockResolvedValue([]) } } as never;
    const trader = new AutoTrader({
      prisma,
      riskAnalyzer: {} as never,
      positionManager: { openPosition: vi.fn() } as never,
      logger: logger as never,
      encryptionKey: 'key',
    });

    const results = await trader.evaluateAndMaybeBuy('MintABC', 'token-1', RISK_FLAGS, 80);

    expect(results).toEqual([]);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ activeConfigCount: 0 }),
      'TOKEN ACCEPTED — evaluating against active auto-buy configs',
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringMatching(/^BUY CANCELLED\nReason:\nno active SnipeConfig/),
    );
  });
});

describe('AutoTrader — per-config wallet selection (SnipeConfig.walletId)', () => {
  const wallet1 = { id: 'wallet-1', publicKey: 'Pubkey1', encryptedSecret: 'enc1' };
  const wallet2 = { id: 'wallet-2', publicKey: 'Pubkey2', encryptedSecret: 'enc2' };

  it('old/existing configs (walletId null) buy from the first active wallet — unchanged behavior', async () => {
    const { trader, openPosition } = setup(
      fakeConfig({ walletId: null, user: { wallets: [wallet1, wallet2] } }),
    );
    await trader.evaluateAndMaybeBuy('MintABC', 'token-1', RISK_FLAGS, 80);
    expect(openPosition).toHaveBeenCalledWith(
      expect.objectContaining({ walletId: 'wallet-1', walletPublicKey: 'Pubkey1' }),
    );
  });

  it('a config pinned to a specific still-active wallet buys from that wallet, not the first one', async () => {
    const { trader, openPosition } = setup(
      fakeConfig({ walletId: 'wallet-2', user: { wallets: [wallet1, wallet2] } }),
    );
    await trader.evaluateAndMaybeBuy('MintABC', 'token-1', RISK_FLAGS, 80);
    expect(openPosition).toHaveBeenCalledWith(
      expect.objectContaining({ walletId: 'wallet-2', walletPublicKey: 'Pubkey2' }),
    );
  });

  it('falls back to the first active wallet when the pinned wallet is no longer active', async () => {
    const { trader, openPosition } = setup(
      // wallet-2 was deactivated — the `user.wallets` include already filters
      // to isActive:true, so a deactivated pinned wallet simply isn't in this list.
      fakeConfig({ walletId: 'wallet-2', user: { wallets: [wallet1] } }),
    );
    await trader.evaluateAndMaybeBuy('MintABC', 'token-1', RISK_FLAGS, 80);
    expect(openPosition).toHaveBeenCalledWith(expect.objectContaining({ walletId: 'wallet-1' }));
  });
});

// The critical-security-gate and pre-buy-sellability-precheck behavior
// previously tested here moved with the checks themselves to
// candidatePipeline.ts (2026-07-22) — see candidatePipeline.test.ts. This
// function no longer runs those checks at all (it assumes upstream already
// passed them for this token), so those scenarios no longer apply here.

describe('AutoTrader — pre-buy sellability failure categorization (2026-07-21 audit, section D)', () => {
  function setupWithOpenPositionError(err: Error) {
    const config = fakeConfig();
    const prisma = { snipeConfig: { findMany: vi.fn().mockResolvedValue([config]) } } as never;
    const positionManager = { openPosition: vi.fn().mockRejectedValue(err) } as never;
    return new AutoTrader({
      prisma,
      riskAnalyzer: {} as never,
      positionManager,
      logger: fakeLogger(),
      encryptionKey: 'key',
    });
  }

  it('reports a SellabilityCheckError as reason "not_sellable", distinct from a generic execution error', async () => {
    const trader = setupWithOpenPositionError(new SellabilityCheckError('no_sell_route'));

    const results = await trader.evaluateAndMaybeBuy('MintABC', 'token-1', RISK_FLAGS, 80);

    expect(results).toEqual([{ userId: 'user-1', bought: false, reason: 'not_sellable' }]);
  });

  it('still categorizes a genuine SafetyCheckError as "safety_blocked", unaffected by the new sellability handling', async () => {
    const trader = setupWithOpenPositionError(new SafetyCheckError('daily loss limit reached'));

    const results = await trader.evaluateAndMaybeBuy('MintABC', 'token-1', RISK_FLAGS, 80);

    expect(results).toEqual([{ userId: 'user-1', bought: false, reason: 'safety_blocked' }]);
  });
});
