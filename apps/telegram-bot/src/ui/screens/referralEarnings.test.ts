import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient, User } from '@prisma/client';
import { renderReferralEarnings } from './referralEarnings.js';
import type { ScreenDeps } from '../types.js';

function fakeDeps(rewards: Record<string, unknown>[]): ScreenDeps {
  const prisma = {
    referralReward: { findMany: vi.fn().mockResolvedValue(rewards) },
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

describe('renderReferralEarnings', () => {
  it('shows an empty state when there are no rewards yet', async () => {
    const deps = fakeDeps([]);
    const result = await renderReferralEarnings(deps, user);
    expect(result.text).toContain('No referral earnings yet');
  });

  it('lists each reward with level, amount, and source', async () => {
    const deps = fakeDeps([
      {
        level: 1,
        rewardUsd: 4.2,
        referredUserId: 'referred-1',
        createdAt: new Date('2026-07-11T12:00:00Z'),
        referredUser: { telegramId: '999888777' },
      },
    ]);
    const result = await renderReferralEarnings(deps, user);
    expect(result.text).toContain('Level 1');
    expect(result.text).toContain('$4.20');
    expect(result.text).toContain('999888777');
  });
});
