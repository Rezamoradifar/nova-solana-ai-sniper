import { describe, expect, it } from 'vitest';
import type { RiskFlags } from '@nova/shared';
import {
  classifySecurityState,
  evaluateCriticalSecurityGate,
  HARD_MAX_TOP10_HOLDER_PERCENT,
  HARD_MIN_HOLDER_COUNT,
} from './criticalSecurityGate.js';

function safeFlags(overrides: Partial<RiskFlags> = {}): RiskFlags {
  return {
    mintAuthorityRevoked: true,
    freezeAuthorityRevoked: true,
    lpBurnedOrLocked: true,
    top10HolderPercent: 20,
    isHoneypotSuspected: false,
    liquidityUsd: 50_000,
    liquiditySource: 'dexscreener',
    holderCount: 50,
    ...overrides,
  };
}

describe('evaluateCriticalSecurityGate', () => {
  it('allows a clean token', () => {
    expect(evaluateCriticalSecurityGate(safeFlags())).toEqual({ allowed: true, reasons: [] });
  });

  it('blocks unrevoked mint authority', () => {
    const result = evaluateCriticalSecurityGate(safeFlags({ mintAuthorityRevoked: false }));
    expect(result.allowed).toBe(false);
    expect(result.reasons).toContain('mint_authority_not_revoked');
  });

  it('blocks unrevoked freeze authority', () => {
    const result = evaluateCriticalSecurityGate(safeFlags({ freezeAuthorityRevoked: false }));
    expect(result.reasons).toContain('freeze_authority_not_revoked');
  });

  it('blocks unlocked/unburned LP', () => {
    const result = evaluateCriticalSecurityGate(safeFlags({ lpBurnedOrLocked: false }));
    expect(result.reasons).toContain('lp_not_locked_or_burned');
  });

  it('blocks a suspected honeypot regardless of any other signal', () => {
    const result = evaluateCriticalSecurityGate(safeFlags({ isHoneypotSuspected: true }));
    expect(result.reasons).toContain('honeypot_suspected');
  });

  it('blocks when liquidity could not be resolved (fail-closed on unavailable data)', () => {
    const result = evaluateCriticalSecurityGate(safeFlags({ liquiditySource: 'unavailable' }));
    expect(result.reasons).toContain('dexscreener_validation_failed');
  });

  it('blocks when liquiditySource is missing entirely (fail-closed on undefined, same as unavailable)', () => {
    const result = evaluateCriticalSecurityGate(safeFlags({ liquiditySource: undefined }));
    expect(result.reasons).toContain('dexscreener_validation_failed');
  });

  it('blocks a pre-migration pump.fun bonding-curve estimate — pump.fun is discovery-only, never a direct buy source', () => {
    const result = evaluateCriticalSecurityGate(
      safeFlags({ liquiditySource: 'pumpfun_bonding_curve' }),
    );
    expect(result.allowed).toBe(false);
    expect(result.reasons).toContain('dexscreener_validation_failed');
  });

  it('blocks a native-DEX on-chain reserve read — only an independent DexScreener listing counts as validated', () => {
    const result = evaluateCriticalSecurityGate(safeFlags({ liquiditySource: 'native_dex' }));
    expect(result.reasons).toContain('dexscreener_validation_failed');
  });

  it('blocks a Jupiter price-impact estimate — the least confident fallback source', () => {
    const result = evaluateCriticalSecurityGate(safeFlags({ liquiditySource: 'jupiter_estimate' }));
    expect(result.reasons).toContain('dexscreener_validation_failed');
  });

  it('allows a real DexScreener-confirmed listing', () => {
    const result = evaluateCriticalSecurityGate(safeFlags({ liquiditySource: 'dexscreener' }));
    expect(result.allowed).toBe(true);
  });

  it('blocks holder concentration at/above the hard ceiling', () => {
    const atCeiling = evaluateCriticalSecurityGate(
      safeFlags({ top10HolderPercent: HARD_MAX_TOP10_HOLDER_PERCENT }),
    );
    expect(atCeiling.reasons).toContain('holder_concentration_critical');

    const justBelow = evaluateCriticalSecurityGate(
      safeFlags({ top10HolderPercent: HARD_MAX_TOP10_HOLDER_PERCENT - 1 }),
    );
    expect(justBelow.reasons).not.toContain('holder_concentration_critical');
  });

  it('does not block a real, legitimately concentrated-but-established token (regression: MOODENG at 54%)', () => {
    const result = evaluateCriticalSecurityGate(
      safeFlags({ top10HolderPercent: 54, holderCount: 20 }),
    );
    expect(result.allowed).toBe(true);
  });

  it('blocks holder count below the hard floor, including when unavailable (undefined -> 0)', () => {
    const belowFloor = evaluateCriticalSecurityGate(
      safeFlags({ holderCount: HARD_MIN_HOLDER_COUNT - 1 }),
    );
    expect(belowFloor.reasons).toContain('holder_count_critical');

    const missing = evaluateCriticalSecurityGate(safeFlags({ holderCount: undefined }));
    expect(missing.reasons).toContain('holder_count_critical');

    const atFloor = evaluateCriticalSecurityGate(safeFlags({ holderCount: HARD_MIN_HOLDER_COUNT }));
    expect(atFloor.reasons).not.toContain('holder_count_critical');
  });

  it('regression: blocks the exact "Larry" incident (honeypot + 93% concentration) even with a perfect AI score elsewhere in the pipeline', () => {
    // This gate never sees an AI/Opportunity score at all — that's the point:
    // it's evaluated purely from deterministic risk flags, before any score
    // gate runs, so a 100 AI score computed downstream cannot rescue this.
    const result = evaluateCriticalSecurityGate(
      safeFlags({ isHoneypotSuspected: true, top10HolderPercent: 93, holderCount: 100 }),
    );
    expect(result.allowed).toBe(false);
    expect(result.reasons).toContain('honeypot_suspected');
  });

  it('regression: blocks a single/two-holder honeypot with implausibly large recorded liquidity ("ㅤ"/"Zca" incidents)', () => {
    const result = evaluateCriticalSecurityGate(
      safeFlags({
        isHoneypotSuspected: true,
        top10HolderPercent: 99.96,
        holderCount: 2,
        liquidityUsd: 21_411_120.22,
        liquiditySource: 'dexscreener',
      }),
    );
    expect(result.allowed).toBe(false);
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        'honeypot_suspected',
        'holder_concentration_critical',
        'holder_count_critical',
      ]),
    );
  });

  it('returns every failing reason at once, not just the first', () => {
    const result = evaluateCriticalSecurityGate(
      safeFlags({
        mintAuthorityRevoked: false,
        freezeAuthorityRevoked: false,
        isHoneypotSuspected: true,
      }),
    );
    expect(result.reasons.length).toBeGreaterThanOrEqual(3);
  });

  describe('UNKNOWN vs UNSAFE (2026-07-22 audit: never report a data-source failure as a confirmed finding)', () => {
    it('still blocks (UNKNOWN must block, same as UNSAFE) but reports a distinct "unknown" reason for mint/freeze authority', () => {
      const result = evaluateCriticalSecurityGate(
        safeFlags({
          mintAuthorityRevoked: false,
          freezeAuthorityRevoked: false,
          mintAuthorityDataUnknown: true,
        }),
      );
      expect(result.allowed).toBe(false);
      expect(result.reasons).toContain('mint_authority_unknown');
      expect(result.reasons).toContain('freeze_authority_unknown');
      expect(result.reasons).not.toContain('mint_authority_not_revoked');
      expect(result.reasons).not.toContain('freeze_authority_not_revoked');
    });

    it('reports the confirmed reason (not unknown) when authority data was genuinely resolved', () => {
      const result = evaluateCriticalSecurityGate(safeFlags({ mintAuthorityRevoked: false }));
      expect(result.reasons).toContain('mint_authority_not_revoked');
      expect(result.reasons).not.toContain('mint_authority_unknown');
    });

    it('reports a distinct "holder_data_unknown" instead of holder_concentration_critical/holder_count_critical when holder data itself is unverified', () => {
      const result = evaluateCriticalSecurityGate(
        safeFlags({ top10HolderPercent: 100, holderCount: 0, holderDataUnknown: true }),
      );
      expect(result.allowed).toBe(false);
      expect(result.reasons).toContain('holder_data_unknown');
      expect(result.reasons).not.toContain('holder_concentration_critical');
      expect(result.reasons).not.toContain('holder_count_critical');
    });

    it('reports honeypot_check_unknown instead of honeypot_suspected when suspicion is solely due to unknown upstream data', () => {
      const result = evaluateCriticalSecurityGate(
        safeFlags({
          mintAuthorityRevoked: false,
          mintAuthorityDataUnknown: true,
          isHoneypotSuspected: true,
          honeypotCheckUnknown: true,
        }),
      );
      expect(result.reasons).toContain('honeypot_check_unknown');
      expect(result.reasons).not.toContain('honeypot_suspected');
    });

    it('still reports confirmed honeypot_suspected when a genuinely low liquidity reading triggered it, even if authority data also happens to be unknown', () => {
      const result = evaluateCriticalSecurityGate(
        safeFlags({
          isHoneypotSuspected: true,
          honeypotCheckUnknown: false, // riskAnalyzer.ts only sets this true when liquidity wasn't the trigger
          liquidityUsd: 10,
        }),
      );
      expect(result.reasons).toContain('honeypot_suspected');
      expect(result.reasons).not.toContain('honeypot_check_unknown');
    });
  });
});

describe('classifySecurityState', () => {
  it('reports SAFE across the board for a clean, fully-resolved token', () => {
    expect(classifySecurityState(safeFlags({ holderClusteringState: 'SAFE' }))).toEqual({
      mintAuthority: 'SAFE',
      freezeAuthority: 'SAFE',
      lpLock: 'SAFE',
      honeypot: 'SAFE',
      dexscreenerValidation: 'SAFE',
      holderConcentration: 'SAFE',
      holderCount: 'SAFE',
      holderClustering: 'SAFE',
    });
  });

  it('reports UNKNOWN (not UNSAFE) for authority/holder/honeypot when their data is unverified', () => {
    const breakdown = classifySecurityState(
      safeFlags({
        mintAuthorityRevoked: false,
        freezeAuthorityRevoked: false,
        mintAuthorityDataUnknown: true,
        top10HolderPercent: 100,
        holderCount: 0,
        holderDataUnknown: true,
        isHoneypotSuspected: true,
        honeypotCheckUnknown: true,
      }),
    );
    expect(breakdown.mintAuthority).toBe('UNKNOWN');
    expect(breakdown.freezeAuthority).toBe('UNKNOWN');
    expect(breakdown.holderConcentration).toBe('UNKNOWN');
    expect(breakdown.holderCount).toBe('UNKNOWN');
    expect(breakdown.honeypot).toBe('UNKNOWN');
  });

  it('reports UNKNOWN holderClustering when riskAnalyzer never set it (holder data itself unresolved)', () => {
    const breakdown = classifySecurityState(safeFlags({ holderClusteringState: undefined }));
    expect(breakdown.holderClustering).toBe('UNKNOWN');
  });

  it('reports UNSAFE for a genuinely confirmed-bad token, distinct from UNKNOWN', () => {
    const breakdown = classifySecurityState(
      safeFlags({ mintAuthorityRevoked: false, top10HolderPercent: 95, holderCount: 2 }),
    );
    expect(breakdown.mintAuthority).toBe('UNSAFE');
    expect(breakdown.holderConcentration).toBe('UNSAFE');
    expect(breakdown.holderCount).toBe('UNSAFE');
  });
});

describe('evaluateCriticalSecurityGate — bundled-wallet clustering (2026-07-23 USOH incident follow-up)', () => {
  it('blocks a confirmed bundled-wallet cluster even when every other check passes (regression: USOH — 100% clean gate, top10=2.5%, 19 holders)', () => {
    const result = evaluateCriticalSecurityGate(
      safeFlags({
        top10HolderPercent: 2.5,
        holderCount: 19,
        holderClusteringState: 'UNSAFE',
        holderClusteringReasons: ['bundled_wallet_cluster_detected'],
      }),
    );
    expect(result.allowed).toBe(false);
    expect(result.reasons).toContain('bundled_wallet_cluster_detected');
  });

  it('surfaces every clustering-specific reason (e.g. creator-in-cluster), not just a generic one', () => {
    const result = evaluateCriticalSecurityGate(
      safeFlags({
        holderClusteringState: 'UNSAFE',
        holderClusteringReasons: ['bundled_wallet_cluster_detected', 'creator_wallet_in_cluster'],
      }),
    );
    expect(result.reasons).toEqual(
      expect.arrayContaining(['bundled_wallet_cluster_detected', 'creator_wallet_in_cluster']),
    );
  });

  it('does not block on a SAFE clustering verdict', () => {
    const result = evaluateCriticalSecurityGate(safeFlags({ holderClusteringState: 'SAFE' }));
    expect(result.allowed).toBe(true);
  });

  it('does not add a redundant reason when clustering is UNKNOWN — holder_data_unknown already covers that failure mode', () => {
    const result = evaluateCriticalSecurityGate(
      safeFlags({
        top10HolderPercent: 100,
        holderCount: 0,
        holderDataUnknown: true,
        holderClusteringState: 'UNKNOWN',
      }),
    );
    expect(result.reasons).toContain('holder_data_unknown');
    expect(result.reasons).not.toContain('bundled_wallet_cluster_detected');
  });
});
