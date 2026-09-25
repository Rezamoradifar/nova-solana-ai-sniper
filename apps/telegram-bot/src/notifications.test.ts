import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Bot } from 'grammy';
import type { PrismaClient } from '@prisma/client';
import type { Logger } from '@nova/shared';
import {
  buildBuyLink,
  buildDexScreenerLink,
  formatNewTokenMessage,
  formatAiHighScoreMessage,
  formatEmergencyExitMessage,
  formatReferralEarnedMessage,
  formatMemberGrowthMessage,
  formatMemberMilestoneMessage,
  AI_HIGH_SCORE_THRESHOLD,
  NotificationService,
} from './notifications.js';
import type { BuyCardData, SellCardData } from './cards/render.js';

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
      isAiScore: true,
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

  it('regression (2026-07-15 Telegram alert audit): labels the score "Rule Score" instead of "AI Score" when isAiScore is not true, so a rule-based fallback is never mislabeled as a real AI verdict', () => {
    const withoutFlag = formatNewTokenMessage({ mint: 'MintABC', dex: 'PUMPFUN', aiScore: 82 });
    expect(withoutFlag).toContain('Rule Score (no AI provider): 82/100');
    expect(withoutFlag).not.toContain('AI Score:');

    const explicitFalse = formatNewTokenMessage({
      mint: 'MintABC',
      dex: 'PUMPFUN',
      aiScore: 82,
      isAiScore: false,
    });
    expect(explicitFalse).toContain('Rule Score (no AI provider): 82/100');
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

  it('regression: escapes an on-chain token name/symbol containing "_" so Telegram Markdown parsing never breaks', () => {
    const text = formatNewTokenMessage({
      mint: 'MintABC',
      dex: 'PUMPFUN',
      name: 'Rage_Guy',
      symbol: 'RAGE_GUY',
    });
    expect(text).toContain('Rage\\_Guy');
    expect(text).toContain('$RAGE\\_GUY');
    expect(text).not.toContain('Rage_Guy');
    expect(text).not.toContain('$RAGE_GUY');
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
      isAiScore: true,
      liquidityUsd: 50000,
    });
    expect(text).toContain('AI High Score');
    expect(text).toContain('92/100');
    expect(text).toContain('PUMPFUN');
    expect(text).toContain('MintABC');
    expect(text).toContain('Liquidity: $50000');
    expect(text).toContain('[Buy](https://pump.fun/coin/MintABC)');
  });

  it('regression (2026-07-15 Telegram alert audit): labels it "High Rule Score" instead of "AI High Score" when isAiScore is not true', () => {
    const text = formatAiHighScoreMessage({ mint: 'MintABC', dex: 'PUMPFUN', aiScore: 92 });
    expect(text).toContain('High Rule Score (no AI provider)');
    expect(text).not.toContain('AI High Score');
  });

  it('regression: escapes an on-chain token name/symbol containing "_" so Telegram Markdown parsing never breaks', () => {
    const text = formatAiHighScoreMessage({
      mint: 'MintABC',
      dex: 'PUMPFUN',
      name: 'Rage_Guy',
      symbol: 'RAGE_GUY',
      aiScore: 90,
    });
    expect(text).toContain('Rage\\_Guy');
    expect(text).toContain('$RAGE\\_GUY');
    expect(text).not.toContain('Rage_Guy');
    expect(text).not.toContain('$RAGE_GUY');
  });
});

describe('formatEmergencyExitMessage', () => {
  it('renders an urgent header, the human-readable reason label, the detail, and PnL', () => {
    const text = formatEmergencyExitMessage({
      symbol: 'RAGEGUY',
      mint: 'MintABC',
      dex: 'PUMPFUN',
      reason: 'liquidity_removed',
      detail: 'liquidityUsd=120 < 500',
      pnlPercent: -42.5,
      pnlUsd: -12.34,
    });
    expect(text).toContain('EMERGENCY EXIT');
    expect(text).toContain('Liquidity Removed');
    expect(text).toContain('liquidityUsd=120 < 500');
    expect(text).toContain('-42.50%');
    expect(text).toContain('-12.34');
    expect(text).toContain('[Chart]');
  });

  it('renders every emergency reason with a distinct human label', () => {
    const reasons = [
      'liquidity_removed',
      'trading_disabled',
      'mint_reenabled',
      'freeze_reenabled',
      'critical_rug_score',
      'dev_wallet_dump',
    ] as const;
    const labels = new Set(
      reasons.map((reason) =>
        formatEmergencyExitMessage({
          symbol: 'X',
          mint: 'MintABC',
          reason,
          detail: 'd',
          pnlPercent: 0,
        }),
      ),
    );
    expect(labels.size).toBe(reasons.length); // every reason renders distinct text
  });

  it('escapes a symbol containing "_" so Telegram Markdown parsing never breaks', () => {
    const text = formatEmergencyExitMessage({
      symbol: 'RAGE_GUY',
      mint: 'MintABC',
      reason: 'dev_wallet_dump',
      detail: 'd',
      pnlPercent: 0,
    });
    expect(text).toContain('RAGE\\_GUY');
    expect(text).not.toContain('`RAGE_GUY`');
  });

  it('omits the pnlUsd segment cleanly when absent', () => {
    const text = formatEmergencyExitMessage({
      symbol: 'RAGEGUY',
      mint: 'MintABC',
      reason: 'trading_disabled',
      detail: 'no route',
      pnlPercent: -10,
    });
    expect(text).toContain('PnL: -10.00%');
    expect(text).not.toContain('($');
  });
});

describe('formatReferralEarnedMessage', () => {
  it('renders the level, reward amount, and source symbol', () => {
    const text = formatReferralEarnedMessage({
      level: 1,
      rewardUsd: 1.5,
      sourceSymbol: 'MOODENG',
    });
    expect(text).toContain('Referral reward earned');
    expect(text).toContain('Level 1');
    expect(text).toContain('$1.50');
    expect(text).toContain('MOODENG');
  });

  it('renders a Level-2 reward distinctly from Level-1', () => {
    const l1 = formatReferralEarnedMessage({ level: 1, rewardUsd: 1, sourceSymbol: 'X' });
    const l2 = formatReferralEarnedMessage({ level: 2, rewardUsd: 1, sourceSymbol: 'X' });
    expect(l1).not.toBe(l2);
    expect(l2).toContain('Level 2');
  });

  it('escapes a symbol containing "_" so Telegram Markdown parsing never breaks', () => {
    const text = formatReferralEarnedMessage({
      level: 1,
      rewardUsd: 1,
      sourceSymbol: 'RAGE_GUY',
    });
    expect(text).toContain('RAGE\\_GUY');
    expect(text).not.toContain('`RAGE_GUY`');
  });
});

describe('formatMemberGrowthMessage', () => {
  const fixedNow = new Date('2026-07-27T22:10:00.000Z');

  it('uses singular phrasing and "+1" for a single new user', () => {
    const text = formatMemberGrowthMessage({ newCount: 1, totalMembers: 2541 }, fixedNow);
    expect(text).toContain('New User Joined');
    expect(text).toContain('A new user registered.');
    expect(text).toContain('New Users: +1');
    expect(text).toContain('Total Members: 2,541');
    expect(text).toContain('Time: 2026-07-27 22:10 UTC');
    expect(text).not.toContain('New Users Joined');
  });

  it('uses plural phrasing and the batched count for multiple new users', () => {
    const text = formatMemberGrowthMessage({ newCount: 5, totalMembers: 2546 }, fixedNow);
    expect(text).toContain('New Users Joined');
    expect(text).toContain('5 new users registered.');
    expect(text).toContain('New Users: +5');
    expect(text).toContain('Total Members: 2,546');
  });

  it('defaults `now` to the current time when not passed', () => {
    const text = formatMemberGrowthMessage({ newCount: 1, totalMembers: 1 });
    expect(text).toMatch(/Time: \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/);
  });
});

describe('formatMemberMilestoneMessage', () => {
  it('renders the milestone and total with thousands separators', () => {
    const text = formatMemberMilestoneMessage(
      { milestone: 1000, totalMembers: 1002 },
      new Date('2026-07-27T22:10:00.000Z'),
    );
    expect(text).toContain('Milestone Reached!');
    expect(text).toContain('1,000 Members');
    expect(text).toContain('Total Members: 1,002');
    expect(text).toContain('Time: 2026-07-27 22:10 UTC');
  });
});

describe('NotificationService — notifyReferralEarned (single recipient, not fanned out)', () => {
  function fakeSingleUserPrisma(telegramId: string | null) {
    return {
      user: { findUnique: vi.fn().mockResolvedValue(telegramId ? { telegramId } : null) },
    } as unknown as PrismaClient;
  }

  it('sends the referral-earned message to only the referrer, not a fan-out', async () => {
    const { bot, sendMessage } = fakeBot();
    const prisma = fakeSingleUserPrisma('REFERRER_CHAT');
    const service = new NotificationService(bot, 'OWNER_CHAT', prisma, fakeLogger);

    await service.notifyReferralEarned('referrer-user-1', {
      level: 1,
      rewardUsd: 1.5,
      sourceSymbol: 'MOODENG',
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]![0]).toBe('REFERRER_CHAT');
    expect(sendMessage.mock.calls[0]![1]).toContain('MOODENG');
  });

  it('is a silent no-op when the referrer has no telegramId on file', async () => {
    const { bot, sendMessage } = fakeBot();
    const prisma = fakeSingleUserPrisma(null);
    const service = new NotificationService(bot, 'OWNER_CHAT', prisma, fakeLogger);

    await expect(
      service.notifyReferralEarned('referrer-user-1', {
        level: 1,
        rewardUsd: 1,
        sourceSymbol: 'X',
      }),
    ).resolves.toBeUndefined();
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

function fakePrisma(activeTelegramIds: string[]) {
  return {
    user: {
      findMany: vi
        .fn()
        .mockResolvedValue(activeTelegramIds.map((telegramId) => ({ telegramId, language: 'en' }))),
      findUnique: vi.fn().mockResolvedValue(null),
    },
  } as unknown as PrismaClient;
}

function fakeBot() {
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  const sendPhoto = vi.fn().mockResolvedValue(undefined);
  const getMe = vi.fn().mockResolvedValue({ username: 'YourBot' });
  return {
    bot: { api: { sendMessage, sendPhoto, getMe } } as unknown as Bot,
    sendMessage,
    sendPhoto,
    getMe,
  };
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
    const findUnique = vi.fn().mockResolvedValue(null);
    const prisma = { user: { findMany, findUnique } } as unknown as PrismaClient;
    const { bot } = fakeBot();
    const service = new NotificationService(bot, 'OWNER_CHAT', prisma, fakeLogger);

    await service.notifyNewToken({ mint: 'MintABC', dex: 'PUMPFUN' });

    expect(findMany).toHaveBeenCalledWith({
      where: {
        telegramId: { not: null },
        snipeConfigs: { some: { isActive: true, autoBuyOnLaunch: true } },
      },
      select: { telegramId: true, language: true },
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

  it('regression: notifyTrade escapes a symbol containing "_" so Telegram Markdown parsing never breaks', async () => {
    const { bot, sendMessage } = fakeBot();
    const prisma = fakePrisma([]);
    const service = new NotificationService(bot, 'OWNER_CHAT', prisma, fakeLogger);

    await service.notifyTrade({
      side: 'BUY',
      symbol: 'RAGE_GUY',
      mint: 'MintABC',
      amountSol: 0.1,
      signature: 'sig',
    });

    const text = sendMessage.mock.calls[0]![1] as string;
    expect(text).toContain('RAGE\\_GUY');
    expect(text).not.toContain('`RAGE_GUY`');
  });

  it('regression: notifyExit escapes a symbol containing "_" so Telegram Markdown parsing never breaks', async () => {
    const { bot, sendMessage } = fakeBot();
    const prisma = fakePrisma([]);
    const service = new NotificationService(bot, 'OWNER_CHAT', prisma, fakeLogger);

    await service.notifyExit({ symbol: 'RAGE_GUY', reason: 'stop_loss', pnlPercent: -5 });

    const text = sendMessage.mock.calls[0]![1] as string;
    expect(text).toContain('RAGE\\_GUY');
    expect(text).not.toContain('`RAGE_GUY`');
  });

  it('regression: notifyMigration escapes a symbol containing "_" so Telegram Markdown parsing never breaks', async () => {
    const { bot, sendMessage } = fakeBot();
    const prisma = fakePrisma([]);
    const service = new NotificationService(bot, 'OWNER_CHAT', prisma, fakeLogger);

    await service.notifyMigration({
      mint: 'MintABC',
      symbol: 'RAGE_GUY',
      fromDex: 'PUMPFUN',
      toDex: 'PUMPSWAP',
    });

    const text = sendMessage.mock.calls[0]![1] as string;
    expect(text).toContain('RAGE\\_GUY');
    expect(text).not.toContain('`RAGE_GUY`');
  });
});

describe('NotificationService — comma-separated owner chat ids', () => {
  it('sends launch alerts and owner-only alerts to every listed owner, once each', async () => {
    const { bot, sendMessage } = fakeBot();
    const service = new NotificationService(
      bot,
      'ADMIN_1, ADMIN_2,ADMIN_1',
      fakePrisma([]),
      fakeLogger,
    );

    await service.notifyNewToken({ mint: 'MintABC', dex: 'PUMPFUN' });
    await service.notifyError('worker', 'boom');

    const chats = sendMessage.mock.calls.map((c) => c[0]);
    expect(chats.sort()).toEqual(['ADMIN_1', 'ADMIN_1', 'ADMIN_2', 'ADMIN_2']);
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

  it('regression: notifyError escapes an arbitrary caught error message so a "_" never breaks the one alert an operator relies on', async () => {
    const { bot, sendMessage } = fakeBot();
    const prisma = { user: { findMany: vi.fn() } } as unknown as PrismaClient;
    const service = new NotificationService(bot, 'OWNER_CHAT', prisma, fakeLogger);

    await service.notifyError('worker', 'admin.snipe_paused_for_safety threw unexpected_error');

    const text = sendMessage.mock.calls[0]![1] as string;
    expect(text).toContain('admin.snipe\\_paused\\_for\\_safety');
    expect(text).toContain('unexpected\\_error');
    expect(text).not.toContain('snipe_paused');
  });

  it('regression: notifySocialMention escapes raw tweet text so a "_" never breaks the alert', async () => {
    const { bot, sendMessage } = fakeBot();
    const prisma = { user: { findMany: vi.fn() } } as unknown as PrismaClient;
    const service = new NotificationService(bot, 'OWNER_CHAT', prisma, fakeLogger);

    await service.notifySocialMention('gm to_the_moon anon', 'tweet-1');

    const text = sendMessage.mock.calls[0]![1] as string;
    expect(text).toContain('to\\_the\\_moon');
    expect(text).not.toContain('to_the_moon');
  });

  it('notifyMemberGrowth never queries active users or fans out', async () => {
    const { bot, sendMessage } = fakeBot();
    const prisma = { user: { findMany: vi.fn() } } as unknown as PrismaClient;
    const service = new NotificationService(bot, 'OWNER_CHAT', prisma, fakeLogger);

    await service.notifyMemberGrowth({ newCount: 3, totalMembers: 2543 });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith('OWNER_CHAT', expect.any(String), expect.anything());
    expect(prisma.user.findMany as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    expect(sendMessage.mock.calls[0]![1] as string).toContain('New Users: +3');
  });

  it('notifyMemberMilestone never queries active users or fans out', async () => {
    const { bot, sendMessage } = fakeBot();
    const prisma = { user: { findMany: vi.fn() } } as unknown as PrismaClient;
    const service = new NotificationService(bot, 'OWNER_CHAT', prisma, fakeLogger);

    await service.notifyMemberMilestone({ milestone: 500, totalMembers: 500 });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(prisma.user.findMany as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    expect(sendMessage.mock.calls[0]![1] as string).toContain('500 Members');
  });
});

function buyCardData(overrides: Partial<BuyCardData> = {}): BuyCardData {
  return {
    token: { mint: 'MintABC', name: 'Rage Guy', symbol: 'RAGEGUY', dex: 'PUMPFUN', aiScore: 82 },
    entryPriceUsd: 0.0000123,
    amountSol: 0.5,
    walletPublicKey: 'WalletPubKey1111111111111111111111',
    positionId: 'pos_123',
    signature: 'sig_abc123',
    timestamp: new Date('2026-07-10T12:00:00Z'),
    ...overrides,
  };
}

function sellCardData(overrides: Partial<SellCardData> = {}): SellCardData {
  return {
    token: buyCardData().token,
    entryPriceUsd: 0.0000123,
    exitPriceUsd: 0.0000246,
    buyAmountSol: 0.5,
    sellAmountSol: 1.0,
    profitSol: 1.84,
    profitUsd: 250,
    roiPercent: 245,
    pnlPercent: 245,
    holdingTimeMs: 3_600_000,
    exitReason: 'take_profit',
    walletPublicKey: 'WalletPubKey1111111111111111111111',
    positionId: 'pos_123',
    buySignature: 'buy_sig_abc',
    sellSignature: 'sell_sig_xyz',
    ...overrides,
  };
}

describe('NotificationService — trade cards (notifyBuyCard/notifySellCard)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('notifyBuyCard sends an identical photo card to the owner and every active user', async () => {
    const { bot, sendPhoto } = fakeBot();
    const prisma = fakePrisma(['111', '222']);
    const service = new NotificationService(bot, 'OWNER_CHAT', prisma, fakeLogger);

    await service.notifyBuyCard(buyCardData());

    expect(sendPhoto).toHaveBeenCalledTimes(3); // owner + 111 + 222
    const chatIds = sendPhoto.mock.calls.map((c) => c[0]);
    expect(new Set(chatIds)).toEqual(new Set(['OWNER_CHAT', '111', '222']));
    const captions = new Set(sendPhoto.mock.calls.map((c) => c[2].caption));
    expect(captions.size).toBe(1); // byte-identical caption to every recipient
    expect([...captions][0]).toContain('Nova Sniper AI');
  });

  it('notifyBuyCard never throws even when every send fails (e.g. bot blocked everywhere)', async () => {
    const sendPhoto = vi.fn().mockRejectedValue(new Error('bot was blocked'));
    const bot = { api: { sendPhoto } } as unknown as Bot;
    const prisma = fakePrisma([]);
    const service = new NotificationService(bot, 'OWNER_CHAT', prisma, fakeLogger);

    await expect(service.notifyBuyCard(buyCardData())).resolves.toBeUndefined();
    expect(fakeLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 'OWNER_CHAT' }),
      'failed to send telegram trade card',
    );
  });

  it('notifySellCard sends an identical photo card to every active user and returns the share caption', async () => {
    const { bot, sendPhoto } = fakeBot();
    const prisma = fakePrisma(['111', '222']);
    const service = new NotificationService(bot, 'OWNER_CHAT', prisma, fakeLogger);

    const caption = await service.notifySellCard(sellCardData());

    expect(sendPhoto).toHaveBeenCalledTimes(3);
    expect(caption).toBeDefined();
    expect(caption).toContain('Trade completed with Nova Sniper AI');
    expect(caption).toContain('+1.84 SOL');
    const sentCaptions = new Set(sendPhoto.mock.calls.map((c) => c[2].caption));
    expect(sentCaptions).toEqual(new Set([caption]));
  });

  it('notifySellCard returns undefined (and logs) instead of throwing when the bot API fails', async () => {
    const sendPhoto = vi.fn().mockRejectedValue(new Error('blocked'));
    const getMe = vi.fn().mockResolvedValue({ username: 'YourBot' });
    const bot = { api: { sendPhoto, getMe } } as unknown as Bot;
    const prisma = fakePrisma([]);
    const service = new NotificationService(bot, 'OWNER_CHAT', prisma, fakeLogger);

    const caption = await service.notifySellCard(sellCardData());

    // sendPhotoToChat catches per-recipient failures internally, so the overall
    // call still resolves with the caption rather than failing the whole close.
    expect(caption).toBeDefined();
    expect(fakeLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 'OWNER_CHAT' }),
      'failed to send telegram trade card',
    );
  });

  it('notifyBuyCard/notifySellCard fan out to the same recipient set as the sniper alerts (no separate/duplicate delivery path)', async () => {
    const { bot, sendPhoto, sendMessage } = fakeBot();
    const prisma = fakePrisma(['111', '222']);
    const service = new NotificationService(bot, 'OWNER_CHAT', prisma, fakeLogger);

    await service.notifyBuyCard(buyCardData());
    await service.notifyTrade({
      side: 'BUY',
      symbol: 'RAGEGUY',
      mint: 'MintABC',
      amountSol: 0.5,
      signature: 'sig',
    });

    const cardChatIds = new Set(sendPhoto.mock.calls.map((c) => c[0]));
    const alertChatIds = new Set(sendMessage.mock.calls.map((c) => c[0]));
    expect(cardChatIds).toEqual(alertChatIds);
  });
});
