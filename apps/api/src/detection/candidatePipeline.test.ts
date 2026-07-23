import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RiskFlags } from '@nova/shared';
import {
  isRetryableRejection,
  resetRejectionAlertDedupCache,
  runCandidatePipeline,
} from './candidatePipeline.js';

beforeEach(() => {
  resetRejectionAlertDedupCache();
});

function fakeLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
}

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

function fakeRiskAnalyzer(riskFlags: RiskFlags | Error) {
  return {
    analyze:
      riskFlags instanceof Error
        ? vi.fn().mockRejectedValue(riskFlags)
        : vi.fn().mockResolvedValue(riskFlags),
  } as never;
}

/** Always-sellable Jupiter fake: forward quote + reverse quote both clean. */
function fakeSellableJupiter() {
  return {
    getQuote: vi.fn().mockResolvedValue({ outAmount: '1000000', priceImpactPct: '0.01' }),
  } as never;
}

function fakePrisma(blacklistMatch: unknown = null) {
  return {
    blacklistEntry: { findUnique: vi.fn().mockResolvedValue(blacklistMatch) },
  } as never;
}

const CANDIDATE = { mint: 'MintABC', dex: 'RAYDIUM' as const, poolAddress: 'Pool1' };

describe('isRetryableRejection', () => {
  it('is retryable when every reason means "could not verify yet"', () => {
    expect(isRetryableRejection(['dexscreener_validation_failed'])).toBe(true);
    expect(isRetryableRejection(['holder_data_unknown'])).toBe(true);
    expect(isRetryableRejection(['dexscreener_validation_failed', 'holder_data_unknown'])).toBe(
      true,
    );
    expect(isRetryableRejection(['mint_authority_unknown', 'freeze_authority_unknown'])).toBe(true);
    expect(isRetryableRejection(['risk_analysis_failed'])).toBe(true);
    expect(isRetryableRejection(['deployer_check_failed'])).toBe(true);
    expect(isRetryableRejection(['sellability_check_failed'])).toBe(true);
  });

  it('is never retryable once even one reason is a confirmed-bad verdict', () => {
    expect(isRetryableRejection(['honeypot_suspected'])).toBe(false);
    expect(isRetryableRejection(['lp_not_locked_or_burned'])).toBe(false);
    expect(isRetryableRejection(['deployer_blacklisted'])).toBe(false);
    expect(isRetryableRejection(['no_sell_route'])).toBe(false);
    expect(isRetryableRejection(['holder_concentration_critical'])).toBe(false);
    // Mixed: one transient + one confirmed-bad reason must still reject for good.
    expect(isRetryableRejection(['dexscreener_validation_failed', 'honeypot_suspected'])).toBe(
      false,
    );
  });

  it('is not retryable when there is nothing to reject', () => {
    expect(isRetryableRejection([])).toBe(false);
  });
});

describe('runCandidatePipeline', () => {
  it('passes a clean token with no deployer address (nothing to check)', async () => {
    const result = await runCandidatePipeline(
      {
        riskAnalyzer: fakeRiskAnalyzer(safeFlags()),
        jupiter: fakeSellableJupiter(),
        prisma: fakePrisma(),
        logger: fakeLogger(),
      },
      CANDIDATE,
    );

    expect(result.passed).toBe(true);
    if (result.passed) {
      expect(result.riskFlags.liquiditySource).toBe('dexscreener');
      expect(result.timestamps.sellabilityVerifiedAt).toBeGreaterThanOrEqual(
        result.timestamps.analysisStartedAt,
      );
    }
  });

  it('critical-gate failure short-circuits before the sellability reverse-quote is even attempted', async () => {
    const jupiter = fakeSellableJupiter();
    const result = await runCandidatePipeline(
      {
        riskAnalyzer: fakeRiskAnalyzer(safeFlags({ isHoneypotSuspected: true })),
        jupiter,
        prisma: fakePrisma(),
        logger: fakeLogger(),
      },
      CANDIDATE,
    );

    expect(result.passed).toBe(false);
    if (!result.passed) {
      expect(result.reasons).toContain('honeypot_suspected');
      // riskFlags still present on failure — lets the caller upsert a Token
      // row for dedupe purposes even though the candidate was rejected.
      expect(result.riskFlags?.isHoneypotSuspected).toBe(true);
    }
    // Only the forward quote (part of the parallel Promise.allSettled batch)
    // should have run — the reverse quote inside checkSellability never fires
    // once the critical gate has already failed.
    expect((jupiter as { getQuote: ReturnType<typeof vi.fn> }).getQuote).toHaveBeenCalledTimes(1);
  });

  it('blocks a blacklisted deployer even when every other check passes', async () => {
    const result = await runCandidatePipeline(
      {
        riskAnalyzer: fakeRiskAnalyzer(safeFlags()),
        jupiter: fakeSellableJupiter(),
        prisma: fakePrisma({ id: 'bl-1', type: 'DEPLOYER', value: 'BadDeployer111' }),
        logger: fakeLogger(),
      },
      { ...CANDIDATE, deployerAddress: 'BadDeployer111' },
    );

    expect(result.passed).toBe(false);
    if (!result.passed) expect(result.reasons).toContain('deployer_blacklisted');
  });

  it('does not fail when a deployer address is resolvable but not blacklisted', async () => {
    const result = await runCandidatePipeline(
      {
        riskAnalyzer: fakeRiskAnalyzer(safeFlags()),
        jupiter: fakeSellableJupiter(),
        prisma: fakePrisma(null),
        logger: fakeLogger(),
      },
      { ...CANDIDATE, deployerAddress: 'GoodDeployer111' },
    );

    expect(result.passed).toBe(true);
  });

  it('a missing/unresolved deployer address passes through — not a fail-closed skip (deny-list check, not a token-risk signal)', async () => {
    const prisma = fakePrisma();
    const result = await runCandidatePipeline(
      {
        riskAnalyzer: fakeRiskAnalyzer(safeFlags()),
        jupiter: fakeSellableJupiter(),
        prisma,
        logger: fakeLogger(),
      },
      { ...CANDIDATE, deployerAddress: undefined },
    );

    expect(result.passed).toBe(true);
    expect(
      (prisma as { blacklistEntry: { findUnique: ReturnType<typeof vi.fn> } }).blacklistEntry
        .findUnique,
    ).not.toHaveBeenCalled();
  });

  it('fails closed when the deployer blacklist lookup itself errors (distinct from an unresolved address)', async () => {
    const prisma = {
      blacklistEntry: { findUnique: vi.fn().mockRejectedValue(new Error('db down')) },
    } as never;
    const result = await runCandidatePipeline(
      {
        riskAnalyzer: fakeRiskAnalyzer(safeFlags()),
        jupiter: fakeSellableJupiter(),
        prisma,
        logger: fakeLogger(),
      },
      { ...CANDIDATE, deployerAddress: 'SomeDeployer111' },
    );

    expect(result.passed).toBe(false);
    if (!result.passed) expect(result.reasons).toContain('deployer_check_failed');
  });

  it('fails closed (never a false pass) when riskAnalyzer.analyze throws', async () => {
    const result = await runCandidatePipeline(
      {
        riskAnalyzer: fakeRiskAnalyzer(new Error('RPC outage')),
        jupiter: fakeSellableJupiter(),
        prisma: fakePrisma(),
        logger: fakeLogger(),
      },
      CANDIDATE,
    );

    expect(result.passed).toBe(false);
    if (!result.passed) {
      expect(result.reasons).toContain('risk_analysis_failed');
      // No riskFlags at all here — analyze() itself never produced any.
      expect(result.riskFlags).toBeUndefined();
    }
  });

  it('fails with no_sell_route when the forward (SOL->mint) quote itself fails', async () => {
    const jupiter = { getQuote: vi.fn().mockRejectedValue(new Error('no route')) } as never;
    const result = await runCandidatePipeline(
      {
        riskAnalyzer: fakeRiskAnalyzer(safeFlags()),
        jupiter,
        prisma: fakePrisma(),
        logger: fakeLogger(),
      },
      CANDIDATE,
    );

    expect(result.passed).toBe(false);
    if (!result.passed) expect(result.reasons).toContain('no_sell_route');
  });

  it('fails when the reverse (mint->SOL) sellability quote reports excessive price impact', async () => {
    const jupiter = {
      getQuote: vi
        .fn()
        .mockResolvedValueOnce({ outAmount: '1000000', priceImpactPct: '0.01' }) // forward
        .mockResolvedValueOnce({ outAmount: '1', priceImpactPct: '0.9' }), // reverse — 90% impact
    } as never;
    const result = await runCandidatePipeline(
      {
        riskAnalyzer: fakeRiskAnalyzer(safeFlags()),
        jupiter,
        prisma: fakePrisma(),
        logger: fakeLogger(),
      },
      CANDIDATE,
    );

    expect(result.passed).toBe(false);
    if (!result.passed) expect(result.reasons).toContain('exit_price_impact_too_high');
  });

  it('sends a notifyError alert including the mint when the critical gate blocks', async () => {
    const notifyError = vi.fn().mockResolvedValue(undefined);
    await runCandidatePipeline(
      {
        riskAnalyzer: fakeRiskAnalyzer(safeFlags({ isHoneypotSuspected: true })),
        jupiter: fakeSellableJupiter(),
        prisma: fakePrisma(),
        logger: fakeLogger(),
        notifier: { notifyError } as never,
      },
      CANDIDATE,
    );

    expect(notifyError).toHaveBeenCalledTimes(1);
    expect(notifyError.mock.calls[0]![1]).toContain('MintABC');
  });

  it('does not re-send a Telegram alert for the same mint + same rejection reasons on a repeat evaluation', async () => {
    const notifyError = vi.fn().mockResolvedValue(undefined);
    const deps = {
      riskAnalyzer: fakeRiskAnalyzer(safeFlags({ isHoneypotSuspected: true })),
      jupiter: fakeSellableJupiter(),
      prisma: fakePrisma(),
      logger: fakeLogger(),
      notifier: { notifyError } as never,
    };

    await runCandidatePipeline(deps, CANDIDATE);
    await runCandidatePipeline(deps, CANDIDATE);
    await runCandidatePipeline(deps, CANDIDATE);

    expect(notifyError).toHaveBeenCalledTimes(1);
  });

  it('sends a fresh alert when the same mint later fails for a different reason (security state actually changed)', async () => {
    const notifyError = vi.fn().mockResolvedValue(undefined);
    const logger = fakeLogger();

    await runCandidatePipeline(
      {
        riskAnalyzer: fakeRiskAnalyzer(safeFlags({ isHoneypotSuspected: true })),
        jupiter: fakeSellableJupiter(),
        prisma: fakePrisma(),
        logger,
        notifier: { notifyError } as never,
      },
      CANDIDATE,
    );
    await runCandidatePipeline(
      {
        riskAnalyzer: fakeRiskAnalyzer(safeFlags({ mintAuthorityRevoked: false })),
        jupiter: fakeSellableJupiter(),
        prisma: fakePrisma(),
        logger,
        notifier: { notifyError } as never,
      },
      CANDIDATE,
    );

    expect(notifyError).toHaveBeenCalledTimes(2);
  });
});
