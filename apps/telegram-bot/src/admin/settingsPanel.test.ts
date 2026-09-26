import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { Logger } from '@nova/shared';
import { checkFeeBudget, parsePercentToBps } from '@nova/shared';
import { applyEdit, renderPanel } from './settingsPanel.js';

const TREASURY = '7TxyBBtqKN6CuhA1jG7zwpuUG4DgwvwzZLctJ2Dno5zP';
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;

function settings(overrides: Record<string, unknown> = {}) {
  return {
    id: 'bs-1',
    performanceFeeBps: 2000,
    referralProgramEnabled: true,
    maxReferralDepth: 2,
    feeSystemActivatedAt: new Date(0),
    treasuryWalletAddress: null,
    referralLevels: [
      { level: 1, percentBps: 1000, enabled: true },
      { level: 2, percentBps: 500, enabled: true },
    ],
    safetyWeightBps: 5000,
    momentumWeightBps: 0,
    walletWeightBps: 0,
    socialWeightBps: 0,
    aiWeightBps: 5000,
    liquidityDepthWeightBps: 0,
    ...overrides,
  };
}

function fakePrisma(current = settings()) {
  const update = vi.fn().mockResolvedValue({});
  const upsert = vi.fn().mockResolvedValue({});
  const prisma = {
    businessSettings: { findFirst: vi.fn().mockResolvedValue(current), update },
    referralLevelConfig: { upsert },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  } as unknown as PrismaClient;
  return { prisma, update, upsert };
}

describe('parsePercentToBps', () => {
  it('accepts plain, percent-suffixed and decimal input', () => {
    expect(parsePercentToBps('20')).toBe(2000);
    expect(parsePercentToBps('12.5%')).toBe(1250);
    expect(parsePercentToBps('7,5')).toBe(750);
  });
  it('rejects out-of-range or non-numeric input', () => {
    expect(parsePercentToBps('-1')).toBeUndefined();
    expect(parsePercentToBps('101')).toBeUndefined();
    expect(parsePercentToBps('abc')).toBeUndefined();
  });
});

describe('checkFeeBudget', () => {
  it('allows referral levels that fit inside the fee', () => {
    expect(checkFeeBudget(settings(), { feeBps: 1500 })).toBeUndefined();
  });
  it('rejects a fee lower than the referral levels combined', () => {
    expect(checkFeeBudget(settings(), { feeBps: 1000 })).toMatch(/more than the platform fee/);
  });
  it('rejects a referral level that would push the total over the fee', () => {
    expect(checkFeeBudget(settings(), { level: 1, levelBps: 1600 })).toMatch(/more than/);
  });
});

describe('applyEdit', () => {
  it('saves a valid treasury address', async () => {
    const { prisma, update } = fakePrisma();
    expect(await applyEdit(prisma, logger, 1, 'treasury', TREASURY)).toBeUndefined();
    expect(update).toHaveBeenCalledWith({
      where: { id: 'bs-1' },
      data: { treasuryWalletAddress: TREASURY },
    });
  });
  it('refuses an invalid treasury address without writing', async () => {
    const { prisma, update } = fakePrisma();
    expect(await applyEdit(prisma, logger, 1, 'treasury', 'not-a-wallet')).toMatch(/not a valid/);
    expect(update).not.toHaveBeenCalled();
  });
  it('saves a new fee', async () => {
    const { prisma, update } = fakePrisma();
    expect(await applyEdit(prisma, logger, 1, 'fee', '25')).toBeUndefined();
    expect(update).toHaveBeenCalledWith({
      where: { id: 'bs-1' },
      data: { performanceFeeBps: 2500 },
    });
  });
  it('refuses a fee below the referral total', async () => {
    const { prisma, update } = fakePrisma();
    expect(await applyEdit(prisma, logger, 1, 'fee', '10')).toMatch(/more than the platform fee/);
    expect(update).not.toHaveBeenCalled();
  });
  it('saves a referral level', async () => {
    const { prisma, upsert } = fakePrisma();
    expect(await applyEdit(prisma, logger, 1, 'level2', '3')).toBeUndefined();
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { percentBps: 300, enabled: true } }),
    );
  });
});

describe('renderPanel', () => {
  it('shows the env treasury as fallback and the current split', () => {
    const { text } = renderPanel(settings(), TREASURY);
    expect(text).toContain(TREASURY);
    expect(text).toContain('from server .env');
    expect(text).toContain('Platform fee:* 20%');
    expect(text).toContain('User keeps: 80%');
    expect(text).toContain('Level 1: 10%');
    expect(text).toContain('Level 2: 5%');
  });
  it('prefers the panel-set treasury', () => {
    const { text } = renderPanel(settings({ treasuryWalletAddress: 'PanelAddr' }), TREASURY);
    expect(text).toContain('PanelAddr');
    expect(text).toContain('set in this panel');
  });
});
