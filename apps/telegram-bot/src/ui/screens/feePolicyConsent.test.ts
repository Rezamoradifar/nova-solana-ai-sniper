import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient, User } from '@prisma/client';
import {
  handleAcceptFeePolicy,
  hasAcceptedCurrentFeePolicy,
  renderFeePolicyConsent,
} from './feePolicyConsent.js';
import type { ScreenDeps } from '../types.js';

function fakeDeps(settings: Record<string, unknown> = {}): {
  deps: ScreenDeps;
  update: ReturnType<typeof vi.fn>;
} {
  const businessSettingsFindFirst = vi.fn().mockResolvedValue({
    id: 'settings-1',
    performanceFeeBps: 2000,
    referralProgramEnabled: true,
    maxReferralDepth: 2,
    referralLevels: [
      { level: 1, percentBps: 1000, enabled: true },
      { level: 2, percentBps: 500, enabled: false },
    ],
    ...settings,
  });
  const update = vi.fn().mockResolvedValue({ id: 'user-1', feePolicyAcceptedAt: new Date() });
  const prisma = {
    businessSettings: { findFirst: businessSettingsFindFirst, create: vi.fn() },
    user: { update },
  } as unknown as PrismaClient;
  return {
    deps: {
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
    } as ScreenDeps,
    update,
  };
}

describe('hasAcceptedCurrentFeePolicy', () => {
  it('is false for a user who has never accepted anything', async () => {
    const { deps } = fakeDeps();
    const user = { id: 'user-1', feePolicyAcceptedAt: null, feePolicyAcceptedFeeBps: null } as User;
    expect(await hasAcceptedCurrentFeePolicy(deps, user)).toBe(false);
  });

  it('is true when the accepted fee % matches the current setting', async () => {
    const { deps } = fakeDeps();
    const user = {
      id: 'user-1',
      feePolicyAcceptedAt: new Date(),
      feePolicyAcceptedFeeBps: 2000,
    } as User;
    expect(await hasAcceptedCurrentFeePolicy(deps, user)).toBe(true);
  });

  it('is false when the accepted fee % is stale (admin changed it since)', async () => {
    const { deps } = fakeDeps();
    const user = {
      id: 'user-1',
      feePolicyAcceptedAt: new Date(),
      feePolicyAcceptedFeeBps: 1000, // accepted 10%, current is 20%
    } as User;
    expect(await hasAcceptedCurrentFeePolicy(deps, user)).toBe(false);
  });
});

describe('renderFeePolicyConsent', () => {
  it('shows the current fee %, user share, and only enabled referral levels', async () => {
    const { deps } = fakeDeps();
    const user = { id: 'user-1' } as User;
    const result = await renderFeePolicyConsent(deps, user);
    expect(result.text).toContain('20.0%'); // fee
    expect(result.text).toContain('80.0%'); // user share
    expect(result.text).toContain('Level 1: 10.0%');
    expect(result.text).not.toContain('Level 2'); // disabled
  });

  it('shows the program-disabled message when the referral program itself is off', async () => {
    const { deps } = fakeDeps({ referralProgramEnabled: false });
    const user = { id: 'user-1' } as User;
    const result = await renderFeePolicyConsent(deps, user);
    expect(result.text).toContain('Referral program is currently disabled');
  });
});

describe('handleAcceptFeePolicy', () => {
  it('stamps the current fee % onto the user row and returns the updated user', async () => {
    const { deps, update } = fakeDeps();
    const user = { id: 'user-1' } as User;
    const result = await handleAcceptFeePolicy(deps, user);
    expect(update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { feePolicyAcceptedAt: expect.any(Date), feePolicyAcceptedFeeBps: 2000 },
    });
    expect(result.feePolicyAcceptedAt).toBeInstanceOf(Date);
  });
});
