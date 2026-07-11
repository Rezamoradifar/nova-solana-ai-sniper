import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient, Position, Token, User } from '@prisma/client';
import { renderPositions } from './positions.js';
import type { ScreenDeps } from '../types.js';

function fakeDeps(open: (Position & { token: Token })[], closedCount = 0): ScreenDeps {
  const prisma = {
    position: {
      findMany: vi.fn().mockResolvedValue(open),
      count: vi.fn().mockResolvedValue(closedCount),
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
  };
}

const user = { id: 'user-1' } as User;

function fakePosition(overrides: Partial<Position & { token: Token }> = {}): Position & {
  token: Token;
} {
  return {
    id: 'pos-1',
    amountSolInvested: 0.5,
    takeProfitPercent: null,
    stopLossPercent: null,
    trailingStopPreset: null,
    trailingStopPercent: null,
    highWaterMarkUsd: null,
    entryPriceUsd: 0.0001,
    token: { symbol: 'RAGEGUY', mint: 'MintABC1234567890' } as Token,
    ...overrides,
  } as Position & { token: Token };
}

describe('renderPositions', () => {
  it('regression: escapes a "meme_coin" trailing-stop preset so its "_" never breaks Telegram Markdown parsing', async () => {
    // Live bug: TRAILING_STOP_PRESETS includes 'meme_coin', whose raw enum value
    // was embedded unescaped into the positions line — the unpaired "_" reliably
    // broke this exact line for every user on the Meme Coin Mode preset.
    const position = fakePosition({
      trailingStopPreset: 'meme_coin',
      trailingStopPercent: 20,
      highWaterMarkUsd: 0.0002,
    });
    const result = await renderPositions(fakeDeps([position]), user);
    expect(result.text).toContain('[meme\\_coin]');
    expect(result.text).not.toContain('[meme_coin]');
  });

  it('shows plain TP/SL for positions without a trailing-stop preset', async () => {
    const position = fakePosition({ takeProfitPercent: 50, stopLossPercent: 20 });
    const result = await renderPositions(fakeDeps([position]), user);
    expect(result.text).toContain('TP 50%');
    expect(result.text).toContain('SL 20%');
  });

  it('shows an empty-state message when there are no open positions', async () => {
    const result = await renderPositions(fakeDeps([]), user);
    expect(result.text).toContain('No open positions');
  });
});
