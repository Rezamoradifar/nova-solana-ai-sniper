import { describe, expect, it } from 'vitest';
import {
  parseTraders,
  pnlTone,
  signedValue,
  traderDataLive,
  type TraderSnapshot,
} from './copyTraders.js';
const now = Date.now();
const data = (): TraderSnapshot => ({
  source: 'GMGN',
  chain: 'solana',
  scope: 'active_smart_money_sample',
  period: '7d',
  status: 'connected',
  updatedAt: now,
  performanceUpdatedAt: now,
  refreshMs: 30_000,
  traders: [
    {
      address: 'DZAa55HwXgv5hStwaTEJGXZz1DhHejvpb7Yr762urXam',
      name: 'Trader',
      tags: [],
      observedTrades: 3,
      observedVolumeUsd: 1000,
      lastActivityAt: now,
      performance: { realizedPnlUsd: 123.45, roiPct: 7.5, winRatePct: 65, buys: 3, sells: 2 },
    },
  ],
});
describe('copy trader display evidence', () => {
  it('requires the selected period and Solana source identity', () => {
    expect(parseTraders(data(), '7d').traders).toHaveLength(1);
    expect(() => parseTraders(data(), '30d')).toThrow();
    expect(() => parseTraders({ ...data(), chain: 'base' }, '7d')).toThrow();
  });
  it('expires live labels, rejects future clocks, and never renews failed snapshots', () => {
    expect(traderDataLive(data(), now)).toBe(true);
    expect(traderDataLive(data(), now + 90_001)).toBe(false);
    expect(traderDataLive({ ...data(), performanceUpdatedAt: now + 6000 }, now)).toBe(false);
    expect(traderDataLive({ ...data(), status: 'unavailable' }, now)).toBe(false);
    expect(traderDataLive({ ...data(), performanceUpdatedAt: null }, now)).toBe(false);
  });
  it('preserves loss/zero/missing distinctions and small SOL profits', () => {
    expect(pnlTone(-12)).toBe('is-loss');
    expect(pnlTone(0)).toBe('is-neutral');
    expect(pnlTone(null)).toBe('is-neutral');
    expect(pnlTone(1)).toBe('is-profit');
    expect(signedValue(null, 'USD')).toBe('—');
    expect(signedValue(-12.5, 'USD')).toBe('-$12.50');
    expect(signedValue(0.00181, 'SOL')).toBe('+0.00181 SOL');
  });
});
