import { describe, expect, it } from 'vitest';
import { computeSellRetryBackoffMs } from './sellRetryBackoff.js';

describe('computeSellRetryBackoffMs', () => {
  it('requires no backoff before any permanent failure has been recorded', () => {
    expect(computeSellRetryBackoffMs(0, 60_000, 1_800_000)).toBe(0);
  });

  it('requires no backoff for a negative count (defensive — should never happen)', () => {
    expect(computeSellRetryBackoffMs(-1, 60_000, 1_800_000)).toBe(0);
  });

  it('doubles the backoff on each consecutive permanent failure', () => {
    expect(computeSellRetryBackoffMs(1, 60_000, 1_800_000)).toBe(60_000);
    expect(computeSellRetryBackoffMs(2, 60_000, 1_800_000)).toBe(120_000);
    expect(computeSellRetryBackoffMs(3, 60_000, 1_800_000)).toBe(240_000);
    expect(computeSellRetryBackoffMs(4, 60_000, 1_800_000)).toBe(480_000);
  });

  it('caps the backoff at maxMs, never growing past it', () => {
    expect(computeSellRetryBackoffMs(10, 60_000, 1_800_000)).toBe(1_800_000);
    expect(computeSellRetryBackoffMs(30, 60_000, 1_800_000)).toBe(1_800_000);
  });

  it('is configurable via baseMs/maxMs independent of the defaults', () => {
    expect(computeSellRetryBackoffMs(1, 1_000, 5_000)).toBe(1_000);
    expect(computeSellRetryBackoffMs(3, 1_000, 5_000)).toBe(4_000);
    expect(computeSellRetryBackoffMs(4, 1_000, 5_000)).toBe(5_000);
  });
});
