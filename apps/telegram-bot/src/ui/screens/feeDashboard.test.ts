import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient, User } from '@prisma/client';
import { renderFeeDashboard } from './feeDashboard.js';
import type { ScreenDeps } from '../types.js';

function fakeDeps(overrides: {
  todayProfit?: number | null;
  lifetimeProfit?: number | null;
  feesPaid?: number | null;
  referralEarnings?: number | null;
  directReferredCount?: number;
  topReferrals?: { referredUserId: string; _sum: { rewardUsd: number | null } }[];
}): ScreenDeps {
  const positionAggregate = vi
    .fn()
    .mockResolvedValueOnce({ _sum: { realizedPnlUsd: overrides.todayProfit ?? 0 } })
    .mockResolvedValueOnce({ _sum: { realizedPnlUsd: overrides.lifetimeProfit ?? 0 } });
  const prisma = {
    wallet: { findMany: vi.fn().mockResolvedValue([{ id: 'wallet-1' }]) },
    position: { aggregate: positionAggregate },
    performanceFeeLedger: {
      aggregate: vi.fn().mockResolvedValue({ _sum: { feeUsd: overrides.feesPaid ?? 0 } }),
    },
    referralReward: {
      aggregate: vi
        .fn()
        .mockResolvedValue({ _sum: { rewardUsd: overrides.referralEarnings ?? 0 } }),
      groupBy: vi.fn().mockResolvedValue(overrides.topReferrals ?? []),
    },
    user: {
      count: vi.fn().mockResolvedValue(overrides.directReferredCount ?? 0),
      findMany: vi.fn().mockResolvedValue([]),
    },
  } as unknown as PrismaClient;
  return {
    prisma,
    encryptionKey: 'key',
    logger: { error: vi.fn() } as never,
    telegramTrend: {
      enabled: false,
      channels: [],
      minAiScore: 50,
      pollIntervalMs: 20000,
      metricsUrl: '',
    },
  } as ScreenDeps;
}

const user = { id: 'user-1', referralCode: 'ABCD1234' } as User;

describe('renderFeeDashboard', () => {
  it('shows today/lifetime profit, fees paid, and referral earnings', async () => {
    const deps = fakeDeps({
      todayProfit: 12.5,
      lifetimeProfit: 340,
      feesPaid: 68,
      referralEarnings: 5.5,
    });
    const result = await renderFeeDashboard(deps, user);
    expect(result.text).toContain('$12.50');
    expect(result.text).toContain('$340.00');
    expect(result.text).toContain('$68.00');
    expect(result.text).toContain('$5.50');
  });

  it('handles a user with zero activity everywhere without crashing', async () => {
    const deps = fakeDeps({});
    const result = await renderFeeDashboard(deps, user);
    expect(result.text).toContain('$0.00');
  });

  it('includes a Top Referrals section only when there are any', async () => {
    const deps = fakeDeps({
      topReferrals: [{ referredUserId: 'referred-1', _sum: { rewardUsd: 3.2 } }],
    });
    const result = await renderFeeDashboard(deps, user);
    expect(result.text).toContain('Top Referrals');
  });

  it('omits the Top Referrals section when there are none', async () => {
    const deps = fakeDeps({ topReferrals: [] });
    const result = await renderFeeDashboard(deps, user);
    expect(result.text).not.toContain('Top Referrals');
  });

  it('links to the earnings history and referral leaderboard screens', async () => {
    const deps = fakeDeps({});
    const result = await renderFeeDashboard(deps, user);
    const callbacks = result.keyboard.inline_keyboard
      .flat()
      .map((b) => ('callback_data' in b ? b.callback_data : undefined));
    expect(callbacks).toContain('s:referral_earnings');
    expect(callbacks).toContain('s:referral_leaderboard');
  });
});
