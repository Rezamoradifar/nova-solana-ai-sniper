import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RiskFlags } from '@nova/shared';
import { isRetryableRejection, runCandidatePipeline } from './candidatePipeline.js';
import { securityGateStats } from './securityGateStats.js';

beforeEach(() => {
  securityGateStats.resetForTests();
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

/** Argument-aware fake — MINT and DEPLOYER blacklist lookups must be
 * independently controllable now that runCandidatePipeline checks both. */
function fakePrisma(opts: { deployerBlacklist?: unknown; mintBlacklist?: unknown } = {}) {
  return {
    blacklistEntry: {
      findUnique: vi
        .fn()
        .mockImplementation(({ where }: { where: { type_value: { type: string } } }) => {
          if (where.type_value.type === 'MINT') return Promise.resolve(opts.mintBlacklist ?? null);
          if (where.type_value.type === 'DEPLOYER')
            return Promise.resolve(opts.deployerBlacklist ?? null);
          return Promise.resolve(null);
        }),
    },
  } as never;
}

/** Same shape, but the mock throws for any lookup — used by tests that need
 * a lookup failure independent of which blacklist type triggers it. */
function fakePrismaThatThrows(err: Error) {
  return {
    blacklistEntry: { findUnique: vi.fn().mockRejectedValue(err) },
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
    expect(isRetryableRejection(['mint_check_failed'])).toBe(true);
    expect(isRetryableRejection(['sellability_check_failed'])).toBe(true);
  });

  it('is never retryable once even one reason is a confirmed-bad, non-age-dependent verdict', () => {
    expect(isRetryableRejection(['deployer_blacklisted'])).toBe(false);
    expect(isRetryableRejection(['mint_blacklisted'])).toBe(false);
    expect(isRetryableRejection(['no_sell_route'])).toBe(false);
    // Mixed: one transient + one confirmed-bad (non-age-dependent) reason must still reject for good.
    expect(isRetryableRejection(['dexscreener_validation_failed', 'deployer_blacklisted'])).toBe(
      false,
    );
  });

  it("is NOT retryable for age-dependent reasons (2026-07-27 audit: a short retry window can never resolve them — a 22h production sample already proved 0% success; they get a real second look via worker.ts's token.migrated re-entry point instead, not a busy-retry loop)", () => {
    expect(isRetryableRejection(['honeypot_suspected'])).toBe(false);
    expect(isRetryableRejection(['lp_not_locked_or_burned'])).toBe(false);
    expect(isRetryableRejection(['holder_concentration_critical'])).toBe(false);
    expect(isRetryableRejection(['holder_count_critical'])).toBe(false);
    // Mixed: one transient + one age-dependent reason is no longer retryable either —
    // the age-dependent reason alone is enough to make the whole rejection final.
    expect(isRetryableRejection(['dexscreener_validation_failed', 'honeypot_suspected'])).toBe(
      false,
    );
    expect(isRetryableRejection(['honeypot_suspected', 'deployer_blacklisted'])).toBe(false);
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
        prisma: fakePrisma({
          deployerBlacklist: { id: 'bl-1', type: 'DEPLOYER', value: 'BadDeployer111' },
        }),
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
        prisma: fakePrisma(),
        logger: fakeLogger(),
      },
      { ...CANDIDATE, deployerAddress: 'GoodDeployer111' },
    );

    expect(result.passed).toBe(true);
  });

  it('a missing/unresolved deployer address passes through — not a fail-closed skip (deny-list check, not a token-risk signal); the MINT check still runs regardless', async () => {
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
    const findUnique = (prisma as { blacklistEntry: { findUnique: ReturnType<typeof vi.fn> } })
      .blacklistEntry.findUnique;
    // The MINT blacklist check is unconditional (runs for every candidate —
    // see mintBlacklist.test.ts), but no DEPLOYER-type lookup should have
    // been attempted since no deployer address was ever available.
    expect(findUnique).toHaveBeenCalledTimes(1);
    expect(findUnique).toHaveBeenCalledWith({
      where: { type_value: { type: 'MINT', value: CANDIDATE.mint } },
    });
  });

  it('fails closed when the deployer blacklist lookup itself errors (distinct from an unresolved address)', async () => {
    const prisma = fakePrismaThatThrows(new Error('db down'));
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
    if (!result.passed) {
      expect(result.reasons).toContain('deployer_check_failed');
      // The MINT lookup (same fake, unconditional) also fails closed.
      expect(result.reasons).toContain('mint_check_failed');
    }
  });

  it('blocks a blacklisted mint even when every other check (and the deployer) passes — the fix for the USOH-incident blacklist gap', async () => {
    const result = await runCandidatePipeline(
      {
        riskAnalyzer: fakeRiskAnalyzer(safeFlags()),
        jupiter: fakeSellableJupiter(),
        prisma: fakePrisma({
          mintBlacklist: { id: 'bl-2', type: 'MINT', value: CANDIDATE.mint, reason: 'incident' },
        }),
        logger: fakeLogger(),
      },
      CANDIDATE,
    );

    expect(result.passed).toBe(false);
    if (!result.passed) expect(result.reasons).toContain('mint_blacklisted');
  });

  it('fails closed when the mint blacklist lookup itself errors', async () => {
    const result = await runCandidatePipeline(
      {
        riskAnalyzer: fakeRiskAnalyzer(safeFlags()),
        jupiter: fakeSellableJupiter(),
        prisma: fakePrismaThatThrows(new Error('db down')),
        logger: fakeLogger(),
      },
      CANDIDATE,
    );

    expect(result.passed).toBe(false);
    if (!result.passed) expect(result.reasons).toContain('mint_check_failed');
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

  it('does not send an individual Telegram alert when the critical gate blocks (Section 8: aggregated summary only)', async () => {
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

    expect(notifyError).not.toHaveBeenCalled();
  });

  it('records every rejection into securityGateStats, even repeat evaluations of the same mint', async () => {
    const deps = {
      riskAnalyzer: fakeRiskAnalyzer(safeFlags({ isHoneypotSuspected: true })),
      jupiter: fakeSellableJupiter(),
      prisma: fakePrisma(),
      logger: fakeLogger(),
    };

    await runCandidatePipeline(deps, CANDIDATE);
    await runCandidatePipeline(deps, CANDIDATE);
    await runCandidatePipeline(deps, CANDIDATE);

    expect(securityGateStats.snapshotAndReset().blockedReasonCounts['honeypot_suspected']).toBe(3);
  });
});

describe('runCandidatePipeline — pumpfunGracePeriodActive wiring (2026-07-27 "unblock buys" audit)', () => {
  const PUMPFUN_CANDIDATE = { mint: 'MintPump', dex: 'PUMPFUN' as const };
  const youngRiskFlags = safeFlags({ liquiditySource: 'pumpfun_bonding_curve', holderCount: 1 });

  it('passes a young, otherwise-clean PUMPFUN candidate within the grace period despite no DexScreener listing / too few holders', async () => {
    const result = await runCandidatePipeline(
      {
        riskAnalyzer: fakeRiskAnalyzer(youngRiskFlags),
        jupiter: fakeSellableJupiter(),
        prisma: fakePrisma(),
        logger: fakeLogger(),
        pumpfunGracePeriodMs: 150_000,
      },
      { ...PUMPFUN_CANDIDATE, tokenDetectedAt: Date.now() - 10_000 },
    );

    expect(result.passed).toBe(true);
  });

  it('rejects the same candidate once the grace period has elapsed', async () => {
    const result = await runCandidatePipeline(
      {
        riskAnalyzer: fakeRiskAnalyzer(youngRiskFlags),
        jupiter: fakeSellableJupiter(),
        prisma: fakePrisma(),
        logger: fakeLogger(),
        pumpfunGracePeriodMs: 150_000,
      },
      { ...PUMPFUN_CANDIDATE, tokenDetectedAt: Date.now() - 200_000 },
    );

    expect(result.passed).toBe(false);
    if (!result.passed) {
      expect(result.reasons).toEqual(
        expect.arrayContaining(['dexscreener_validation_failed', 'holder_count_critical']),
      );
    }
  });

  it('never activates without a tokenDetectedAt, even for a PUMPFUN candidate with pumpfunGracePeriodMs configured', async () => {
    const result = await runCandidatePipeline(
      {
        riskAnalyzer: fakeRiskAnalyzer(youngRiskFlags),
        jupiter: fakeSellableJupiter(),
        prisma: fakePrisma(),
        logger: fakeLogger(),
        pumpfunGracePeriodMs: 150_000,
      },
      PUMPFUN_CANDIDATE,
    );

    expect(result.passed).toBe(false);
  });

  it('never activates without deps.pumpfunGracePeriodMs configured, even with a fresh tokenDetectedAt (matches every existing test/caller in this file, which omits it)', async () => {
    const result = await runCandidatePipeline(
      {
        riskAnalyzer: fakeRiskAnalyzer(youngRiskFlags),
        jupiter: fakeSellableJupiter(),
        prisma: fakePrisma(),
        logger: fakeLogger(),
      },
      { ...PUMPFUN_CANDIDATE, tokenDetectedAt: Date.now() },
    );

    expect(result.passed).toBe(false);
  });

  it('never activates for a non-PUMPFUN dex, even with a fresh tokenDetectedAt and pumpfunGracePeriodMs configured — every other chain/source is unaffected', async () => {
    const result = await runCandidatePipeline(
      {
        riskAnalyzer: fakeRiskAnalyzer(youngRiskFlags),
        jupiter: fakeSellableJupiter(),
        prisma: fakePrisma(),
        logger: fakeLogger(),
        pumpfunGracePeriodMs: 150_000,
      },
      { mint: 'MintRay', dex: 'RAYDIUM' as const, tokenDetectedAt: Date.now() },
    );

    expect(result.passed).toBe(false);
  });

  it('still blocks a young PUMPFUN candidate within the grace period on a genuinely bad signal (mint authority not revoked)', async () => {
    const result = await runCandidatePipeline(
      {
        riskAnalyzer: fakeRiskAnalyzer(
          safeFlags({
            liquiditySource: 'pumpfun_bonding_curve',
            holderCount: 1,
            mintAuthorityRevoked: false,
          }),
        ),
        jupiter: fakeSellableJupiter(),
        prisma: fakePrisma(),
        logger: fakeLogger(),
        pumpfunGracePeriodMs: 150_000,
      },
      { ...PUMPFUN_CANDIDATE, tokenDetectedAt: Date.now() },
    );

    expect(result.passed).toBe(false);
    if (!result.passed) expect(result.reasons).toContain('mint_authority_not_revoked');
  });
});
