import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient, User } from '@prisma/client';
import { renderReferralLeaderboard } from './referralLeaderboard.js';
import type { ScreenDeps } from '../types.js';

function fakeDeps(
  grouped: { referrerUserId: string; _sum: { rewardUsd: number | null } }[],
  users: { id: string; telegramId: string | null }[] = [],
): ScreenDeps {
  const prisma = {
    referralReward: { groupBy: vi.fn().mockResolvedValue(grouped) },
    user: { findMany: vi.fn().mockResolvedValue(users) },
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

const user = { id: 'user-1' } as User;

describe('renderReferralLeaderboard', () => {
  it('shows an empty state when no referral earnings exist', async () => {
    const deps = fakeDeps([]);
    const result = await renderReferralLeaderboard(deps, user);
    expect(result.text).toContain('No referral earnings recorded yet');
  });

  it('ranks referrers by total earned, resolving their display label', async () => {
    const deps = fakeDeps(
      [
        { referrerUserId: 'ref-1', _sum: { rewardUsd: 50 } },
        { referrerUserId: 'ref-2', _sum: { rewardUsd: 20 } },
      ],
      [
        { id: 'ref-1', telegramId: '111222333' },
        { id: 'ref-2', telegramId: null },
      ],
    );
    const result = await renderReferralLeaderboard(deps, user);
    expect(result.text).toContain('1. 111222333 — $50.00');
    expect(result.text).toContain('2.');
  });
});
