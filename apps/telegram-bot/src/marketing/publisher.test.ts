import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Bot } from 'grammy';
import type { Logger } from '@nova/shared';
import { publishPost } from './publisher.js';

const fakeLogger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() } as unknown as Logger;

beforeEach(() => {
  vi.clearAllMocks();
});

function fakeBot() {
  const sendMessage = vi.fn().mockResolvedValue({ message_id: 4242 });
  const sendPhoto = vi.fn().mockResolvedValue({ message_id: 4242 });
  return { bot: { api: { sendMessage, sendPhoto } } as unknown as Bot, sendMessage, sendPhoto };
}

function basePost(overrides: Partial<Parameters<typeof publishPost>[2]> = {}) {
  return {
    id: 'post-1',
    titleEn: 'EN Title',
    bodyEn: 'EN body',
    titleFa: 'عنوان فارسی',
    bodyFa: 'متن فارسی',
    ...overrides,
  };
}

describe('publishPost', () => {
  it('regression: escapes AI-generated title/body containing "_" so Telegram Markdown parsing never breaks', async () => {
    const { bot, sendMessage } = fakeBot();

    await publishPost(
      bot,
      'CHAT_ID',
      basePost({ titleEn: 'Big_News today', bodyEn: 'Get 50%_off now' }),
      fakeLogger,
    );

    const [, text] = sendMessage.mock.calls[0] as [string, string];
    expect(text).toContain('Big\\_News');
    expect(text).toContain('50%\\_off');
    expect(text).not.toContain('Big_News');
    expect(text).not.toContain('50%_off');
  });

  it('returns the sent message id', async () => {
    const { bot } = fakeBot();
    const result = await publishPost(bot, 'CHAT_ID', basePost(), fakeLogger);
    expect(result).toEqual({ messageId: 4242 });
  });

  it('includes both an English and a Persian section, separated by a divider', async () => {
    const { bot, sendMessage } = fakeBot();

    await publishPost(bot, 'CHAT_ID', basePost(), fakeLogger);

    const [, text] = sendMessage.mock.calls[0] as [string, string];
    expect(text).toContain('EN Title');
    expect(text).toContain('EN body');
    expect(text).toContain('عنوان فارسی');
    expect(text).toContain('متن فارسی');
    // Persian section must come after the English section, not interleaved.
    expect(text.indexOf('EN body')).toBeLessThan(text.indexOf('عنوان فارسی'));
  });

  it('sends a photo with the same escaped caption when imagePath is set, and never also sends a separate text message', async () => {
    const { bot, sendPhoto, sendMessage } = fakeBot();

    await publishPost(
      bot,
      'CHAT_ID',
      basePost({ titleEn: 'Launch_Day', imagePath: '/tmp/does-not-need-to-exist.png' }),
      fakeLogger,
    );

    expect(sendPhoto).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();
    const caption = sendPhoto.mock.calls[0]![2].caption as string;
    expect(caption).toContain('Launch\\_Day');
  });

  it("truncates (never fails or double-sends) a caption that exceeds Telegram's 1024-char photo-caption limit", async () => {
    const { bot, sendPhoto } = fakeBot();
    const longBody = 'x'.repeat(2000);

    await publishPost(
      bot,
      'CHAT_ID',
      basePost({ bodyEn: longBody, imagePath: '/tmp/does-not-need-to-exist.png' }),
      fakeLogger,
    );

    const caption = sendPhoto.mock.calls[0]![2].caption as string;
    expect(caption.length).toBeLessThanOrEqual(1024);
    expect(fakeLogger.warn).toHaveBeenCalled();
  });

  it('does not truncate or warn when the caption fits within the limit', async () => {
    const { bot, sendPhoto } = fakeBot();
    await publishPost(bot, 'CHAT_ID', basePost({ imagePath: '/tmp/x.png' }), fakeLogger);

    expect(fakeLogger.warn).not.toHaveBeenCalled();
    const caption = sendPhoto.mock.calls[0]![2].caption as string;
    expect(caption).toContain('EN body');
  });

  it('appends the hashtag line at the very end of the post, after the Persian section', async () => {
    const { bot, sendMessage } = fakeBot();

    await publishPost(
      bot,
      'CHAT_ID',
      basePost({ hashtags: ['#Solana', '#Crypto', '#NovaSolanaAI'] }),
      fakeLogger,
    );

    const [, text] = sendMessage.mock.calls[0] as [string, string];
    expect(text.trim().endsWith('#Solana #Crypto #NovaSolanaAI')).toBe(true);
    expect(text.indexOf('متن فارسی')).toBeLessThan(text.indexOf('#Solana'));
  });

  it('omits the hashtag line entirely when no hashtags are given', async () => {
    const { bot, sendMessage } = fakeBot();
    await publishPost(bot, 'CHAT_ID', basePost(), fakeLogger);

    const [, text] = sendMessage.mock.calls[0] as [string, string];
    expect(text).not.toContain('#');
  });

  it('truncates the body but keeps hashtags fully intact when a photo caption would otherwise exceed 1024 chars', async () => {
    const { bot, sendPhoto } = fakeBot();
    const longBody = 'x'.repeat(2000);
    const hashtags = [
      '#Solana',
      '#SOL',
      '#Crypto',
      '#CryptoTrading',
      '#Web3',
      '#DeFi',
      '#NovaSolanaAI',
    ];

    await publishPost(
      bot,
      'CHAT_ID',
      basePost({ bodyEn: longBody, imagePath: '/tmp/does-not-need-to-exist.png', hashtags }),
      fakeLogger,
    );

    const caption = sendPhoto.mock.calls[0]![2].caption as string;
    expect(caption.length).toBeLessThanOrEqual(1024);
    expect(caption.trim().endsWith(hashtags.join(' '))).toBe(true);
    expect(fakeLogger.warn).toHaveBeenCalled();
  });

  it('logs and rethrows when the Telegram send fails', async () => {
    const sendMessage = vi.fn().mockRejectedValue(new Error('blocked'));
    const bot = { api: { sendMessage } } as unknown as Bot;

    await expect(publishPost(bot, 'CHAT_ID', basePost(), fakeLogger)).rejects.toThrow('blocked');
    expect(fakeLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ postId: 'post-1' }),
      'failed to publish marketing post',
    );
  });
});
