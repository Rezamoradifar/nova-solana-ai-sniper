import { describe, expect, it } from 'vitest';
import { evaluateEntry, type EntryFilterConfig, type EntrySignals } from './entryFilter.js';

function goodSignals(overrides: Partial<EntrySignals> = {}): EntrySignals {
  return {
    liquidityUsd: 10_000,
    liquiditySource: 'dexscreener',
    top10HolderPercent: 20,
    holderCount: 50,
    mintAuthorityRevoked: true,
    freezeAuthorityRevoked: true,
    lpBurnedOrLocked: true,
    isHoneypotSuspected: false,
    recentBuys: 10,
    recentSells: 5,
    recentVolumeUsd: 5000,
    ...overrides,
  };
}

function disabledConfig(overrides: Partial<EntryFilterConfig> = {}): EntryFilterConfig {
  return {
    enabled: false,
    minBuySellRatio: 0,
    minHolderCount: 0,
    minRecentVolumeUsd: 0,
    maxTop10HolderPercent: 100,
    ...overrides,
  };
}

describe('evaluateEntry', () => {
  it("always allows when disabled — reproduces today's pass-through behavior exactly", () => {
    const badSignals = goodSignals({
      mintAuthorityRevoked: false,
      isHoneypotSuspected: true,
      top10HolderPercent: 99,
    });
    expect(evaluateEntry(badSignals, disabledConfig())).toEqual({ allowed: true, reasons: [] });
  });

  it('allows a clean token through every check when enabled with default (never-stricter) thresholds', () => {
    expect(evaluateEntry(goodSignals(), disabledConfig({ enabled: true }))).toEqual({
      allowed: true,
      reasons: [],
    });
  });

  it('rejects when liquidity is unavailable', () => {
    const result = evaluateEntry(
      goodSignals({ liquiditySource: 'unavailable' }),
      disabledConfig({ enabled: true }),
    );
    expect(result.allowed).toBe(false);
    expect(result.reasons).toContain('liquidity_unavailable');
  });

  it('rejects a low-confidence Jupiter price-impact liquidity estimate below the floor', () => {
    const result = evaluateEntry(
      goodSignals({ liquiditySource: 'jupiter_estimate', liquidityUsd: 500 }),
      disabledConfig({ enabled: true }),
    );
    expect(result.reasons).toContain('liquidity_estimate_too_low_confidence');
  });

  it('accepts a Jupiter price-impact estimate at or above the confidence floor', () => {
    const result = evaluateEntry(
      goodSignals({ liquiditySource: 'jupiter_estimate', liquidityUsd: 5000 }),
      disabledConfig({ enabled: true }),
    );
    expect(result.allowed).toBe(true);
  });

  it('rejects unrevoked mint/freeze authority, unlocked LP, and suspected honeypot', () => {
    const result = evaluateEntry(
      goodSignals({
        mintAuthorityRevoked: false,
        freezeAuthorityRevoked: false,
        lpBurnedOrLocked: false,
        isHoneypotSuspected: true,
      }),
      disabledConfig({ enabled: true }),
    );
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        'mint_authority_not_revoked',
        'freeze_authority_not_revoked',
        'lp_not_locked_or_burned',
        'honeypot_suspected',
      ]),
    );
  });

  it('rejects holder concentration above the configured cap', () => {
    const result = evaluateEntry(
      goodSignals({ top10HolderPercent: 80 }),
      disabledConfig({ enabled: true, maxTop10HolderPercent: 50 }),
    );
    expect(result.reasons).toContain('holder_concentration_too_high');
  });

  it('rejects holder count below the configured minimum, only when the minimum is set', () => {
    const belowMin = evaluateEntry(
      goodSignals({ holderCount: 5 }),
      disabledConfig({ enabled: true, minHolderCount: 20 }),
    );
    expect(belowMin.reasons).toContain('holder_count_too_low');

    const unset = evaluateEntry(goodSignals({ holderCount: 5 }), disabledConfig({ enabled: true }));
    expect(unset.allowed).toBe(true);
  });

  it('rejects a low buy/sell ratio (mostly sells — a fake-pump/dump signal), only when configured', () => {
    const result = evaluateEntry(
      goodSignals({ recentBuys: 2, recentSells: 20 }),
      disabledConfig({ enabled: true, minBuySellRatio: 1 }),
    );
    expect(result.reasons).toContain('buy_sell_ratio_too_low');
  });

  it('does not gate on buy/sell ratio when there is no recent activity at all (brand-new token)', () => {
    const result = evaluateEntry(
      goodSignals({ recentBuys: 0, recentSells: 0 }),
      disabledConfig({ enabled: true, minBuySellRatio: 1 }),
    );
    expect(result.reasons).not.toContain('buy_sell_ratio_too_low');
  });

  it('rejects manipulated/washed volume below the configured minimum', () => {
    const result = evaluateEntry(
      goodSignals({ recentVolumeUsd: 10 }),
      disabledConfig({ enabled: true, minRecentVolumeUsd: 1000 }),
    );
    expect(result.reasons).toContain('recent_volume_too_low');
  });

  it('returns every failing reason at once, not just the first', () => {
    const result = evaluateEntry(
      goodSignals({
        liquiditySource: 'unavailable',
        mintAuthorityRevoked: false,
        top10HolderPercent: 90,
      }),
      disabledConfig({ enabled: true, maxTop10HolderPercent: 50 }),
    );
    expect(result.reasons.length).toBeGreaterThanOrEqual(3);
  });
});
