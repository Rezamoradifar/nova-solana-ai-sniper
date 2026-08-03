import { describe, expect, it } from 'vitest';
import { BRANDED_HASHTAG, selectHashtags } from './hashtags.js';

const BASE = {
  category: 'trading_tips' as const,
  titleEn: 'Trade smarter',
  bodyEn: 'Use TP/SL rules.',
};

describe('selectHashtags', () => {
  it('always includes the branded hashtag, last', () => {
    const tags = selectHashtags(BASE, () => 0.5);
    expect(tags).toContain(BRANDED_HASHTAG);
    expect(tags.at(-1)).toBe(BRANDED_HASHTAG);
  });

  it('returns between 5 and 10 hashtags for every seed', () => {
    for (let seed = 0; seed <= 10; seed++) {
      const tags = selectHashtags(BASE, () => seed / 10);
      expect(tags.length).toBeGreaterThanOrEqual(5);
      expect(tags.length).toBeLessThanOrEqual(10);
    }
  });

  it('never returns a duplicate hashtag', () => {
    for (let seed = 0; seed <= 10; seed++) {
      const tags = selectHashtags(BASE, () => seed / 10);
      expect(new Set(tags).size).toBe(tags.length);
    }
  });

  it('mixes broad (#Solana/#Crypto-style) and category-niche tags, not just one or the other', () => {
    const tags = selectHashtags(BASE, () => 0.999);
    expect(tags).toContain('#CryptoTrading');
    expect(
      tags.some((t) => t.startsWith('#Trading') || t.startsWith('#AI') || t.startsWith('#Solana')),
    ).toBe(true);
  });

  it('prioritizes trending-token hashtags for the trending_tokens category', () => {
    const tags = selectHashtags({ ...BASE, category: 'trending_tokens' }, () => 0.5);
    expect(tags).toContain('#Solana');
    expect(tags).toContain('#TrendingTokens');
    expect(tags).toContain('#SolanaMemecoin');
  });

  it('prioritizes security hashtags when the generated copy is about a scam/honeypot topic', () => {
    const tags = selectHashtags(
      {
        category: 'trading_tips',
        titleEn: 'Beware this Honeypot trick',
        bodyEn: 'Scammers drain your wallet.',
      },
      () => 0.5,
    );
    expect(tags).toContain('#CryptoSecurity');
    expect(tags).toContain('#ScamAlert');
    expect(tags).toContain('#Honeypot');
  });

  it('does not use security-priority hashtags for unrelated topics', () => {
    const tags = selectHashtags(BASE, () => 0.5);
    expect(tags).not.toContain('#ScamAlert');
    expect(tags).not.toContain('#Honeypot');
  });

  it('rotates: different random sequences produce different hashtag sets', () => {
    const a = selectHashtags(BASE, () => 0.1);
    const b = selectHashtags(BASE, () => 0.9);
    expect(a).not.toEqual(b);
  });

  it('stays relevant to the category (announcements never pulls trending-token niche tags)', () => {
    const tags = selectHashtags({ ...BASE, category: 'announcements' }, () => 0.5);
    expect(tags).not.toContain('#TrendingTokens');
    expect(tags).not.toContain('#SolanaMemecoin');
  });
});
