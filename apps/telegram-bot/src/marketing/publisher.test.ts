import { describe, expect, it, vi } from 'vitest';
import type { Bot } from 'grammy';
import type { Logger } from '@nova/shared';
import { publishPost } from './publisher.js';

const fakeLogger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() } as unknown as Logger;

function fakeBot() {
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  const sendPhoto = vi.fn().mockResolvedValue(undefined);
  return { bot: { api: { sendMessage, sendPhoto } } as unknown as Bot, sendMessage, sendPhoto };
}

describe('publishPost', () => {
  it('regression: escapes AI-generated title/body containing "_" so Telegram Markdown parsing never breaks', async () => {
    const { bot, sendMessage } = fakeBot();

    await publishPost(
      bot,
      'CHAT_ID',
      { id: 'post-1', title: 'Big_News today', body: 'Get 50%_off now' },
      fakeLogger,
    );

    const [, text] = sendMessage.mock.calls[0] as [string, string];
    expect(text).toContain('Big\\_News');
    expect(text).toContain('50%\\_off');
    expect(text).not.toContain('Big_News');
    expect(text).not.toContain('50%_off');
  });

  it('sends a photo with the same escaped caption when imageUrl is set', async () => {
    const { bot, sendPhoto } = fakeBot();

    await publishPost(
      bot,
      'CHAT_ID',
      {
        id: 'post-1',
        title: 'Launch_Day',
        body: 'body text',
        imageUrl: 'https://example.com/x.png',
      },
      fakeLogger,
    );

    expect(sendPhoto).toHaveBeenCalledTimes(1);
    const caption = sendPhoto.mock.calls[0]![2].caption as string;
    expect(caption).toContain('Launch\\_Day');
  });

  it('logs and rethrows when the Telegram send fails', async () => {
    const sendMessage = vi.fn().mockRejectedValue(new Error('blocked'));
    const bot = { api: { sendMessage } } as unknown as Bot;

    await expect(
      publishPost(bot, 'CHAT_ID', { id: 'post-1', title: 'T', body: 'B' }, fakeLogger),
    ).rejects.toThrow('blocked');
    expect(fakeLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ postId: 'post-1' }),
      'failed to publish marketing post',
    );
  });
});
