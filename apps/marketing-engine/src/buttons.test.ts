import { describe, expect, it } from 'vitest';
import { buildButtons } from './buttons.js';

describe('buildButtons', () => {
  it('includes the dashboard button when it is a valid public https URL', () => {
    const buttons = buildButtons('news', { dashboardUrl: 'https://app.example.com' });
    expect(buttons).toEqual([{ text: '🚀 Open Dashboard', url: 'https://app.example.com' }]);
  });

  it('regression: drops a localhost dashboard URL rather than attaching it — Telegram rejects the whole message otherwise (verified live 2026-07-23)', () => {
    const buttons = buildButtons('news', { dashboardUrl: 'http://localhost:5173' });
    expect(buttons).toEqual([]);
  });

  it('drops a plain http:// URL (Telegram requires https)', () => {
    const buttons = buildButtons('news', { dashboardUrl: 'http://app.example.com' });
    expect(buttons).toEqual([]);
  });

  it('drops a malformed URL instead of throwing', () => {
    expect(() => buildButtons('news', { dashboardUrl: 'not a url' })).not.toThrow();
    expect(buildButtons('news', { dashboardUrl: 'not a url' })).toEqual([]);
  });

  it('returns no buttons at all when nothing is configured', () => {
    expect(buildButtons('news', {})).toEqual([]);
  });

  it('adds the referral button only for the referral category, and only with a valid URL', () => {
    const withUrl = buildButtons('referral', { referralUrl: 'https://app.example.com/ref/abc' });
    expect(withUrl).toContainEqual({
      text: '🎁 Get Your Referral Link',
      url: 'https://app.example.com/ref/abc',
    });

    const otherCategory = buildButtons('news', { referralUrl: 'https://app.example.com/ref/abc' });
    expect(otherCategory).toEqual([]);
  });

  it('adds the community button when configured and valid', () => {
    const buttons = buildButtons('news', { communityUrl: 'https://t.me/example' });
    expect(buttons).toContainEqual({ text: '💬 Join Community', url: 'https://t.me/example' });
  });

  it('combines all applicable buttons together', () => {
    const buttons = buildButtons('referral', {
      dashboardUrl: 'https://app.example.com',
      communityUrl: 'https://t.me/example',
      referralUrl: 'https://app.example.com/ref/abc',
    });
    expect(buttons).toHaveLength(3);
  });
});
