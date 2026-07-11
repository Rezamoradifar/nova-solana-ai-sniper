import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  calculatePerformanceFee,
  calculateReferralRewards,
  getOrCreateBusinessSettings,
  isEligibleForFeeProcessing,
  resolveReferralChain,
  type ReferralLevelInput,
} from './fee.js';

describe('calculatePerformanceFee', () => {
  it('charges 20% of net profit on a clean profitable trade', () => {
    const result = calculatePerformanceFee({
      grossProfitUsd: 100,
      actualNetProfitUsd: 100,
      feeBps: 2000,
    });
    expect(result).toEqual({
      grossProfitUsd: 100,
      tradingCostsUsd: 0,
      netProfitUsd: 100,
      feeBps: 2000,
      feeUsd: 20,
      userShareUsd: 80,
    });
  });

  it('never charges a fee on a losing trade', () => {
    expect(
      calculatePerformanceFee({ grossProfitUsd: -50, actualNetProfitUsd: -50, feeBps: 2000 }),
    ).toBeUndefined();
  });

  it('never charges a fee on an exact break-even trade', () => {
    expect(
      calculatePerformanceFee({ grossProfitUsd: 0, actualNetProfitUsd: 0, feeBps: 2000 }),
    ).toBeUndefined();
  });

  it('derives trading costs from the gap between gross (price-based) and actual (real SOL delta) profit', () => {
    const result = calculatePerformanceFee({
      grossProfitUsd: 100,
      actualNetProfitUsd: 92,
      feeBps: 2000,
    });
    expect(result?.tradingCostsUsd).toBeCloseTo(8);
    expect(result?.netProfitUsd).toBeCloseTo(92);
    expect(result?.feeUsd).toBeCloseTo(18.4);
    expect(result?.userShareUsd).toBeCloseTo(73.6);
  });

  it('clamps to the smaller of gross and actual net profit, even if actual is somehow higher than gross', () => {
    // Defensive: real trading costs are never negative, but never overstate the
    // fee base beyond the "official" gross figure shown elsewhere in the app either.
    const result = calculatePerformanceFee({
      grossProfitUsd: 50,
      actualNetProfitUsd: 200,
      feeBps: 2000,
    });
    expect(result?.netProfitUsd).toBe(50);
  });

  it('rejects a trade that is only profitable on paper (gross) but a real loss once actual costs are counted', () => {
    const result = calculatePerformanceFee({
      grossProfitUsd: 10,
      actualNetProfitUsd: -5,
      feeBps: 2000,
    });
    expect(result).toBeUndefined();
  });

  it('falls back to gross profit as the fee base when the actual net figure is unknown', () => {
    const result = calculatePerformanceFee({
      grossProfitUsd: 40,
      actualNetProfitUsd: undefined,
      feeBps: 2000,
    });
    expect(result?.netProfitUsd).toBe(40);
    expect(result?.tradingCostsUsd).toBe(0);
  });

  it('respects a different configured fee percentage', () => {
    const result = calculatePerformanceFee({
      grossProfitUsd: 100,
      actualNetProfitUsd: 100,
      feeBps: 500, // 5%
    });
    expect(result?.feeUsd).toBeCloseTo(5);
    expect(result?.userShareUsd).toBeCloseTo(95);
  });
});

describe('calculateReferralRewards', () => {
  const levels: ReferralLevelInput[] = [
    { level: 1, percentBps: 1000, enabled: true }, // 10% of the fee
    { level: 2, percentBps: 500, enabled: true }, // 5% of the fee
  ];

  it('distributes the platform fee (not the trader profit) across enabled levels', () => {
    const result = calculateReferralRewards(
      20, // platform fee in USD
      [{ userId: 'referrer-l1' }, { userId: 'referrer-l2' }],
      levels,
      2,
    );
    expect(result).toEqual([
      { referrerUserId: 'referrer-l1', level: 1, percentBps: 1000, rewardUsd: 2 },
      { referrerUserId: 'referrer-l2', level: 2, percentBps: 500, rewardUsd: 1 },
    ]);
  });

  it('skips a disabled level entirely', () => {
    const disabledLevel2: ReferralLevelInput[] = [
      { level: 1, percentBps: 1000, enabled: true },
      { level: 2, percentBps: 500, enabled: false },
    ];
    const result = calculateReferralRewards(
      20,
      [{ userId: 'referrer-l1' }, { userId: 'referrer-l2' }],
      disabledLevel2,
      2,
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.level).toBe(1);
  });

  it('never pays past the configured max depth, even with a longer chain', () => {
    const result = calculateReferralRewards(
      20,
      [{ userId: 'l1' }, { userId: 'l2' }, { userId: 'l3' }],
      [...levels, { level: 3, percentBps: 300, enabled: true }],
      2, // maxDepth caps it at 2, even though a level-3 config exists
    );
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.level)).toEqual([1, 2]);
  });

  it('returns nothing for an empty chain (user has no referrer)', () => {
    expect(calculateReferralRewards(20, [], levels, 2)).toEqual([]);
  });

  it('returns nothing when the fee itself is zero', () => {
    expect(calculateReferralRewards(0, [{ userId: 'l1' }], levels, 2)).toEqual([]);
  });
});

describe('resolveReferralChain', () => {
  function fakePrisma(referrerMap: Record<string, { id: string; referredByCode: string | null }>) {
    const findUnique = vi.fn(
      async ({ where }: { where: { id?: string; referralCode?: string } }) => {
        if (where.id) {
          const byId = Object.values(referrerMap).find((u) => u.id === where.id);
          return byId ? { referredByCode: byId.referredByCode } : null;
        }
        if (where.referralCode) {
          return referrerMap[where.referralCode] ?? null;
        }
        return null;
      },
    );
    return { user: { findUnique } } as unknown as PrismaClient;
  }

  it('walks up two levels of referrers', async () => {
    // user-1 was referred by CODE-A (user-2), who was referred by CODE-B (user-3).
    const prisma = fakePrisma({
      'CODE-A': { id: 'user-2', referredByCode: 'CODE-B' },
      'CODE-B': { id: 'user-3', referredByCode: null },
    });
    vi.mocked(prisma.user.findUnique).mockImplementationOnce((async () => ({
      referredByCode: 'CODE-A',
    })) as never);

    const chain = await resolveReferralChain(prisma, 'user-1', 2);
    expect(chain).toEqual([{ userId: 'user-2' }, { userId: 'user-3' }]);
  });

  it('stops at maxDepth even if the chain is longer', async () => {
    const prisma = fakePrisma({
      'CODE-A': { id: 'user-2', referredByCode: 'CODE-B' },
      'CODE-B': { id: 'user-3', referredByCode: 'CODE-C' },
      'CODE-C': { id: 'user-4', referredByCode: null },
    });
    vi.mocked(prisma.user.findUnique).mockImplementationOnce((async () => ({
      referredByCode: 'CODE-A',
    })) as never);

    const chain = await resolveReferralChain(prisma, 'user-1', 1);
    expect(chain).toEqual([{ userId: 'user-2' }]);
  });

  it('returns an empty chain for a user with no referrer at all', async () => {
    const prisma = fakePrisma({});
    vi.mocked(prisma.user.findUnique).mockImplementationOnce((async () => ({
      referredByCode: null,
    })) as never);

    const chain = await resolveReferralChain(prisma, 'user-1', 2);
    expect(chain).toEqual([]);
  });

  it('guards against a cycle instead of looping forever', async () => {
    // user-2's referrer code points back to user-1 (a data anomaly).
    const prisma = fakePrisma({
      'CODE-A': { id: 'user-2', referredByCode: 'CODE-SELF' },
      'CODE-SELF': { id: 'user-1', referredByCode: 'CODE-A' },
    });
    vi.mocked(prisma.user.findUnique).mockImplementationOnce((async () => ({
      referredByCode: 'CODE-A',
    })) as never);

    const chain = await resolveReferralChain(prisma, 'user-1', 5);
    expect(chain).toEqual([{ userId: 'user-2' }]);
  });
});

describe('getOrCreateBusinessSettings', () => {
  it('returns the existing row when one already exists', async () => {
    const existing = {
      id: 'settings-1',
      performanceFeeBps: 1500,
      referralProgramEnabled: true,
      maxReferralDepth: 3,
      referralLevels: [],
    };
    const findFirst = vi.fn().mockResolvedValue(existing);
    const create = vi.fn();
    const prisma = {
      businessSettings: { findFirst, create },
    } as unknown as PrismaClient;

    const result = await getOrCreateBusinessSettings(prisma);
    expect(result).toBe(existing);
    expect(create).not.toHaveBeenCalled();
  });

  it('lazily seeds sane defaults (20% fee, 2 levels) when none exist yet', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const seeded = {
      id: 'settings-new',
      performanceFeeBps: 2000,
      referralProgramEnabled: true,
      maxReferralDepth: 2,
      referralLevels: [
        { level: 1, percentBps: 1000, enabled: true },
        { level: 2, percentBps: 500, enabled: true },
      ],
    };
    const create = vi.fn().mockResolvedValue(seeded);
    const prisma = {
      businessSettings: { findFirst, create },
    } as unknown as PrismaClient;

    const result = await getOrCreateBusinessSettings(prisma);
    expect(result).toBe(seeded);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ performanceFeeBps: 2000, maxReferralDepth: 2 }),
      }),
    );
  });
});

describe('isEligibleForFeeProcessing', () => {
  const activatedAt = new Date('2026-07-11T22:56:38Z');

  it('is eligible when the position closed after activation (the normal case going forward)', () => {
    const closedAt = new Date('2026-07-12T09:00:00Z');
    expect(isEligibleForFeeProcessing(closedAt, activatedAt)).toBe(true);
  });

  it('is eligible at the exact activation instant (inclusive boundary)', () => {
    expect(isEligibleForFeeProcessing(new Date(activatedAt), activatedAt)).toBe(true);
  });

  it('is NOT eligible for a position that closed before activation — the historical-replay guard', () => {
    const closedAt = new Date('2026-07-10T12:00:00Z'); // before the fee system existed
    expect(isEligibleForFeeProcessing(closedAt, activatedAt)).toBe(false);
  });

  it('is NOT eligible when closedAt is null (never trust an unknown close time as "charge anyway")', () => {
    expect(isEligibleForFeeProcessing(null, activatedAt)).toBe(false);
  });

  it('does not depend on the user account age at all — only the trade close time', () => {
    // An "existing user" (old account) and a "new user" (fresh account) both
    // closing a trade after activation are equally eligible — this function
    // never even takes a user/account-age parameter, by design.
    const closedAt = new Date('2026-07-12T00:00:00Z');
    expect(isEligibleForFeeProcessing(closedAt, activatedAt)).toBe(true);
  });
});
