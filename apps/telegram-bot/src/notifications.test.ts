import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Bot } from 'grammy';
import type { PrismaClient } from '@prisma/client';
import type { Logger } from '@nova/shared';
import {
  buildBuyLink,
  buildDexScreenerLink,
  formatNewTokenMessage,
  formatAiHighScoreMessage,
  AI_HIGH_SCORE_THRESHOLD,
  NotificationService,
} from './notifications.js';

const fakeLogger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() } as unknown as Logger;

describe('buildDexScreenerLink', () => {
  it('builds the standard solana chart URL', () => {
    expect(buildDexScreenerLink('MintABC')).toBe('https://dexscreener.com/solana/MintABC');
  });
});

describe('buildBuyLink', () => {
  it('routes PUMPFUN and PUMPSWAP to the pump.fun coin page', () => {
    expect(buildBuyLink('PUMPFUN', 'MintABC')).toBe('https://pump.fun/coin/MintABC');
    expect(buildBuyLink('PUMPSWAP', 'MintABC')).toBe('https://pump.fun/coin/MintABC');
  });

  it('routes every other DEX, including unknown/future ones, to the universal Jupiter swap link', () => {
    expect(buildBuyLink('RAYDIUM', 'MintABC')).toBe('https://jup.ag/swap/SOL-MintABC');
    expect(buildBuyLink('ORCA', 'MintABC')).toBe('https://jup.ag/swap/SOL-MintABC');
    expect(buildBuyLink('METEORA', 'MintABC')).toBe('https://jup.ag/swap/SOL-MintABC');
    expect(buildBuyLink('SOME_FUTURE_DEX', 'MintABC')).toBe('https://jup.ag/swap/SOL-MintABC');
  });
});

describe('formatNewTokenMessage', () => {
  it('includes name/symbol, liquidity, market cap, AI score, and full risk flags when present', () => {
    const text = formatNewTokenMessage({
      mint: 'MintABC',
      dex: 'PUMPFUN',
      name: 'Rage Guy',
      symbol: 'RAGEGUY',
      liquidityUsd: 12345,
      marketCapUsd: 67890,
      aiScore: 82,
      isHoneypotSuspected: false,
      mintAuthorityRevoked: true,
      freezeAuthorityRevoked: true,
      lpBurnedOrLocked: true,
      top10HolderPercent: 23,
    });
    expect(text).toContain('New PUMPFUN launch');
    expect(text).toContain('Rage Guy');
    expect(text).toContain('$RAGEGUY');
    expect(text).toContain('MintABC');
    expect(text).toContain('Liquidity: $12345');
    expect(text).toContain('Market Cap: $67890');
    expect(text).toContain('AI Score: 82/100');
    expect(text).toContain('Top10 23%');
    expect(text).toContain('[Chart](https://dexscreener.com/solana/MintABC)');
    expect(text).toContain('[Buy](https://pump.fun/coin/MintABC)');
    expect(text).not.toContain('Honeypot');
  });

  it('flags honeypot risk and omits fields that were never resolved', () => {
    const text = formatNewTokenMessage({
      mint: 'MintXYZ',
      dex: 'RAYDIUM',
      isHoneypotSuspected: true,
    });
    expect(text).toContain('🚨');
    expect(text).toContain('Honeypot/rug risk flagged');
    expect(text).not.toContain('Liquidity:');
    expect(text).not.toContain('Market Cap:');
    expect(text).not.toContain('AI Score:');
    expect(text).not.toContain('Risk:');
    expect(text).toContain('[Buy](https://jup.ag/swap/SOL-MintXYZ)');
  });

  it('includes real momentum (DexScreener priceChange), not an invented formula', () => {
    const up = formatNewTokenMessage({ mint: 'M', dex: 'PUMPFUN', priceChangeH1: 12.5 });
    expect(up).toContain('📈');
    expect(up).toContain('12.5%');

    const down = formatNewTokenMessage({ mint: 'M', dex: 'PUMPFUN', priceChangeH1: -8.2 });
    expect(down).toContain('📉');
    expect(down).toContain('-8.2%');
  });
});

describe('formatAiHighScoreMessage', () => {
  it('renders the score, dex, mint, and links', () => {
    const text = formatAiHighScoreMessage({
      mint: 'MintABC',
      dex: 'PUMPFUN',
      name: 'Rage Guy',
      symbol: 'RAGEGUY',
      aiScore: 92,
      liquidityUsd: 50000,
    });
    expect(text).toContain('AI High Score');
    expect(text).toContain('92/100');
    expect(text).toContain('PUMPFUN');
    expect(text).toContain('MintABC');
    expect(text).toContain('Liquidity: $50000');
    expect(text).toContain('[Buy](https://pump.fun/coin/MintABC)');
  });
});

function fakePrisma(activeTelegramIds: string[]) {
  return {
    user: {
      findMany: vi.fn().mockResolvedValue(activeTelegramIds.map((telegramId) => ({ telegramId }))),
    },
  } as unknown as PrismaClient;
}

function fakeBot() {
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  return { bot: { api: { sendMessage } } as unknown as Bot, sendMessage };
}

describe('NotificationService — sniper alert fan-out (notifyTrade/notifyExit/notifyNewToken)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sends to the owner chat and every user with a live SnipeConfig, with identical text', async () => {
    const { bot, sendMessage } = fakeBot();
    const prisma = fakePrisma(['111', '222']);
    const service = new NotificationService(bot, 'OWNER_CHAT', prisma, fakeLogger);

    await service.notifyNewToken({ mint: 'MintABC', dex: 'PUMPFUN' });

    expect(sendMessage).toHaveBeenCalledTimes(3); // owner + 111 + 222
    const chatIds = sendMessage.mock.calls.map((c) => c[0]);
    expect(new Set(chatIds)).toEqual(new Set(['OWNER_CHAT', '111', '222']));
    const texts = new Set(sendMessage.mock.calls.map((c) => c[1]));
    expect(texts.size).toBe(1); // every recipient got byte-identical content
  });

  it('never sends the same chat twice when the owner is also an active user', async () => {
    const { bot, sendMessage } = fakeBot();
    const prisma = fakePrisma(['OWNER_CHAT', '222']); // owner's own telegramId happens to match
    const service = new NotificationService(bot, 'OWNER_CHAT', prisma, fakeLogger);

    await service.notifyTrade({
      side: 'BUY',
      symbol: 'RAGEGUY',
      mint: 'MintABC',
      amountSol: 0.1,
      signature: 'sig',
    });

    expect(sendMessage).toHaveBeenCalledTimes(2); // OWNER_CHAT deduped, + 222
    const chatIds = sendMessage.mock.calls.map((c) => c[0]);
    expect(chatIds.filter((id) => id === 'OWNER_CHAT')).toHaveLength(1);
  });

  it('sends to the owner alone when no user currently has an active SnipeConfig', async () => {
    const { bot, sendMessage } = fakeBot();
    const prisma = fakePrisma([]);
    const service = new NotificationService(bot, 'OWNER_CHAT', prisma, fakeLogger);

    await service.notifyExit({ symbol: 'RAGEGUY', reason: 'stop_loss', pnlPercent: -5 });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith('OWNER_CHAT', expect.any(String), expect.anything());
  });

  it('logs a failure for one recipient without throwing or skipping the rest', async () => {
    const sendMessage = vi
      .fn()
      .mockResolvedValueOnce(undefined) // owner
      .mockRejectedValueOnce(new Error('bot was blocked')) // 111
      .mockResolvedValueOnce(undefined); // 222
    const bot = { api: { sendMessage } } as unknown as Bot;
    const prisma = fakePrisma(['111', '222']);
    const service = new NotificationService(bot, 'OWNER_CHAT', prisma, fakeLogger);

    await expect(
      service.notifyNewToken({ mint: 'MintABC', dex: 'PUMPFUN' }),
    ).resolves.toBeUndefined();

    expect(sendMessage).toHaveBeenCalledTimes(3);
    expect(fakeLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: '111' }),
      'failed to send telegram notification',
    );
  });

  it("the queried SnipeConfig filter matches AutoTrader's own active-sniper query exactly", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const prisma = { user: { findMany } } as unknown as PrismaClient;
    const { bot } = fakeBot();
    const service = new NotificationService(bot, 'OWNER_CHAT', prisma, fakeLogger);

    await service.notifyNewToken({ mint: 'MintABC', dex: 'PUMPFUN' });

    expect(findMany).toHaveBeenCalledWith({
      where: {
        telegramId: { not: null },
        snipeConfigs: { some: { isActive: true, autoBuyOnLaunch: true } },
      },
      select: { telegramId: true },
    });
  });

  it('notifyMigration also fans out — migration is the dominant real-world path a token reaches a non-Pump.fun DEX', async () => {
    const { bot, sendMessage } = fakeBot();
    const prisma = fakePrisma(['111', '222']);
    const service = new NotificationService(bot, 'OWNER_CHAT', prisma, fakeLogger);

    await service.notifyMigration({ mint: 'MintABC', fromDex: 'PUMPFUN', toDex: 'PUMPSWAP' });

    expect(sendMessage).toHaveBeenCalledTimes(3); // owner + 111 + 222
    const chatIds = sendMessage.mock.calls.map((c) => c[0]);
    expect(new Set(chatIds)).toEqual(new Set(['OWNER_CHAT', '111', '222']));
  });

  it('notifyAiHighScore fans out the same way as the other sniper alert types', async () => {
    const { bot, sendMessage } = fakeBot();
    const prisma = fakePrisma(['111', '222']);
    const service = new NotificationService(bot, 'OWNER_CHAT', prisma, fakeLogger);

    await service.notifyAiHighScore({
      mint: 'MintABC',
      dex: 'PUMPFUN',
      aiScore: AI_HIGH_SCORE_THRESHOLD,
    });

    expect(sendMessage).toHaveBeenCalledTimes(3);
    const chatIds = sendMessage.mock.calls.map((c) => c[0]);
    expect(new Set(chatIds)).toEqual(new Set(['OWNER_CHAT', '111', '222']));
  });
});

describe('NotificationService — operational alerts stay owner-only', () => {
  beforeEach(() => vi.clearAllMocks());

  it('notifyError never queries active users or fans out', async () => {
    const { bot, sendMessage } = fakeBot();
    const prisma = { user: { findMany: vi.fn() } } as unknown as PrismaClient;
    const service = new NotificationService(bot, 'OWNER_CHAT', prisma, fakeLogger);

    await service.notifyError('worker', 'boom');

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith('OWNER_CHAT', expect.any(String), expect.anything());
    expect(prisma.user.findMany as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it('notifySocialMention never queries active users or fans out', async () => {
    const { bot, sendMessage } = fakeBot();
    const prisma = { user: { findMany: vi.fn() } } as unknown as PrismaClient;
    const service = new NotificationService(bot, 'OWNER_CHAT', prisma, fakeLogger);

    await service.notifySocialMention('gm', 'tweet-1');

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(prisma.user.findMany as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });
});
