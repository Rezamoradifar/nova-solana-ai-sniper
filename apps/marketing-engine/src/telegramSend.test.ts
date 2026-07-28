import { describe, expect, it, vi } from 'vitest';
import { sendBrandedMessage } from './telegramSend.js';

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
