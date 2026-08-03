import { describe, expect, it, vi } from 'vitest';
import type { AiProvider } from '@nova/ai';
import type { Logger } from '@nova/shared';
import { generateUniquePost } from './generator.js';

const fakeLogger = {
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

function fakeProvider(...responses: string[]): AiProvider {
  const generateText = vi.fn();
  responses.forEach((r) => generateText.mockResolvedValueOnce(r));
  return { name: 'gemini', generateText } as unknown as AiProvider;
}

const VALID = JSON.stringify({
  titleEn: 'Set your stop-loss',
  bodyEn: 'Always protect your downside before you snipe a fresh launch.',
  titleFa: 'حد ضرر خود را تنظیم کنید',
  bodyFa: 'همیشه پیش از خرید یک توکن جدید از سرمایه خود محافظت کنید.',
});

describe('generateUniquePost', () => {
  it('returns a parsed bilingual post on the first valid, unique attempt', async () => {
    const provider = fakeProvider(VALID);
    const result = await generateUniquePost(
      provider,
      'trading_tips',
      async () => false,
      [],
      fakeLogger,
    );

    expect(result).toMatchObject({
      category: 'trading_tips',
      titleEn: 'Set your stop-loss',
      titleFa: 'حد ضرر خود را تنظیم کنید',
    });
    expect(result?.contentHash).toBeTruthy();
    expect(provider.generateText).toHaveBeenCalledTimes(1);
  });

  it('retries when the response is not valid JSON, then succeeds', async () => {
    const provider = fakeProvider('not json at all', VALID);
    const result = await generateUniquePost(provider, 'news', async () => false, [], fakeLogger);

    expect(result).toBeDefined();
    expect(provider.generateText).toHaveBeenCalledTimes(2);
  });

  it('retries when the response is missing a required bilingual field', async () => {
    const missingFa = JSON.stringify({ titleEn: 'T', bodyEn: 'B' });
    const provider = fakeProvider(missingFa, VALID);
    const result = await generateUniquePost(provider, 'news', async () => false, [], fakeLogger);

    expect(result).toBeDefined();
    expect(provider.generateText).toHaveBeenCalledTimes(2);
  });

  it('retries on an exact-hash duplicate, then succeeds', async () => {
    const isDuplicate = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const provider = fakeProvider(VALID, VALID);
    const result = await generateUniquePost(provider, 'trading_tips', isDuplicate, [], fakeLogger);

    expect(result).toBeDefined();
    expect(provider.generateText).toHaveBeenCalledTimes(2);
  });

  it('retries on a near-duplicate of recent content, then succeeds with different content', async () => {
    const recentTexts = [
      'Set your stop-loss\nAlways protect your downside before you snipe a fresh launch.\nحد ضرر خود را تنظیم کنید\nهمیشه پیش از خرید یک توکن جدید از سرمایه خود محافظت کنید.',
    ];
    const different = JSON.stringify({
      titleEn: 'Position sizing 101',
      bodyEn: 'Never risk more than a small slice of your bankroll on a single snipe.',
      titleFa: 'مدیریت حجم معامله',
      bodyFa: 'هرگز بیش از بخش کوچکی از سرمایه خود را روی یک معامله ریسک نکنید.',
    });
    const provider = fakeProvider(VALID, different);
    const result = await generateUniquePost(
      provider,
      'trading_tips',
      async () => false,
      recentTexts,
      fakeLogger,
    );

    expect(result?.titleEn).toBe('Position sizing 101');
    expect(provider.generateText).toHaveBeenCalledTimes(2);
  });

  it('gives up and returns undefined after exhausting max attempts', async () => {
    const provider = fakeProvider('bad', 'bad', 'bad', 'bad', 'bad');
    const result = await generateUniquePost(provider, 'news', async () => false, [], fakeLogger);

    expect(result).toBeUndefined();
    expect(provider.generateText).toHaveBeenCalledTimes(4);
    expect(fakeLogger.error).toHaveBeenCalled();
  });

  it('passes marketFacts through into the prompt sent to the provider', async () => {
    const provider = fakeProvider(VALID);
    await generateUniquePost(
      provider,
      'market_updates',
      async () => false,
      [],
      fakeLogger,
      'SOL price change (24h): +4.2%',
    );

    const [prompt] = (provider.generateText as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(prompt).toContain('SOL price change (24h): +4.2%');
  });
});
