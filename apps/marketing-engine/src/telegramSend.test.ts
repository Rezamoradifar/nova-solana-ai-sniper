import { describe, expect, it, vi } from 'vitest';
import { InputFile } from 'grammy';
import { sendBrandedMessage, sendBrandedPhotoHtml } from './telegramSend.js';

function fakeBot() {
  const sendPhoto = vi.fn().mockResolvedValue({ message_id: 1 });
  const sendMessage = vi.fn().mockResolvedValue({ message_id: 2 });
  return { bot: { api: { sendPhoto, sendMessage } } as never, sendPhoto, sendMessage };
}

describe('sendBrandedMessage', () => {
  it('sends a photo with the text as caption when a logo URL is present', async () => {
    const { bot, sendPhoto, sendMessage } = fakeBot();
    await sendBrandedMessage(bot, '@chat', 'hello', { logoUrl: 'https://example.com/logo.png' });
    expect(sendPhoto).toHaveBeenCalledWith('@chat', 'https://example.com/logo.png', {
      caption: 'hello',
      parse_mode: 'Markdown',
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('falls back to sendMessage with a link preview when no logo is available', async () => {
    const { bot, sendPhoto, sendMessage } = fakeBot();
    await sendBrandedMessage(bot, '@chat', 'hello', {
      linkPreviewUrl: 'https://dexscreener.com/solana/Mint',
    });
    expect(sendPhoto).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith('@chat', 'hello', {
      parse_mode: 'Markdown',
      link_preview_options: { url: 'https://dexscreener.com/solana/Mint' },
    });
  });

  it('falls back to sendMessage without a link preview when neither is available', async () => {
    const { bot, sendMessage } = fakeBot();
    await sendBrandedMessage(bot, '@chat', 'hello');
    expect(sendMessage).toHaveBeenCalledWith('@chat', 'hello', { parse_mode: 'Markdown' });
  });

  it("falls back to text when the caption would exceed Telegram's photo-caption limit", async () => {
    const { bot, sendPhoto, sendMessage } = fakeBot();
    const longText = 'x'.repeat(1025);
    await sendBrandedMessage(bot, '@chat', longText, { logoUrl: 'https://example.com/logo.png' });
    expect(sendPhoto).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith('@chat', longText, { parse_mode: 'Markdown' });
  });
});

describe('sendBrandedPhotoHtml', () => {
  it('sends the buffer as a photo with HTML parse_mode', async () => {
    const { bot, sendPhoto } = fakeBot();
    const buf = Buffer.from('fake-png');

    await sendBrandedPhotoHtml(bot, '@chat', buf, '<b>hello</b>');

    expect(sendPhoto).toHaveBeenCalledTimes(1);
    const [chatId, photo, opts] = sendPhoto.mock.calls[0]!;
    expect(chatId).toBe('@chat');
    expect(photo).toBeInstanceOf(InputFile);
    expect(opts).toEqual({ caption: '<b>hello</b>', parse_mode: 'HTML', reply_markup: undefined });
  });

  it('attaches an inline keyboard built from the given button rows', async () => {
    const { bot, sendPhoto } = fakeBot();
    const buf = Buffer.from('fake-png');

    await sendBrandedPhotoHtml(bot, '@chat', buf, 'caption', [
      [
        { text: 'Buy', url: 'https://jup.ag/swap/SOL-Mint' },
        { text: 'Chart', url: 'https://dexscreener.com/solana/Mint' },
      ],
      [{ text: 'Website', url: 'https://novasniper.ai' }],
    ]);

    const [, , opts] = sendPhoto.mock.calls[0]!;
    expect(opts.reply_markup.inline_keyboard).toEqual([
      [
        { text: 'Buy', url: 'https://jup.ag/swap/SOL-Mint' },
        { text: 'Chart', url: 'https://dexscreener.com/solana/Mint' },
      ],
      [{ text: 'Website', url: 'https://novasniper.ai' }],
    ]);
  });

  it('omits reply_markup entirely when no buttons are given', async () => {
    const { bot, sendPhoto } = fakeBot();
    await sendBrandedPhotoHtml(bot, '@chat', Buffer.from('x'), 'caption', []);
    const [, , opts] = sendPhoto.mock.calls[0]!;
    expect(opts.reply_markup).toBeUndefined();
  });

  it('falls back to sendMessage (still with buttons) when no photo could be resolved', async () => {
    const { bot, sendPhoto, sendMessage } = fakeBot();

    await sendBrandedPhotoHtml(bot, '@chat', undefined, 'caption', [
      [{ text: 'Buy', url: 'https://jup.ag/swap/SOL-Mint' }],
    ]);

    expect(sendPhoto).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith('@chat', 'caption', {
      parse_mode: 'HTML',
      reply_markup: expect.objectContaining({
        inline_keyboard: [[{ text: 'Buy', url: 'https://jup.ag/swap/SOL-Mint' }]],
      }),
    });
  });

  it('sends a fileId photo directly without wrapping it in InputFile', async () => {
    const { bot, sendPhoto } = fakeBot();

    await sendBrandedPhotoHtml(bot, '@chat', { fileId: 'AgADabc123' }, 'caption');

    const [, photo] = sendPhoto.mock.calls[0]!;
    expect(photo).toBe('AgADabc123');
  });
});
