import { describe, expect, it } from 'vitest';
import {
  lamportsToSol,
  numberOrFallback,
  pct,
  percent,
  pnlToneClass,
  sol,
  timeAgo,
  usd,
} from './format.js';

describe('usd', () => {
  it('formats a positive value', () => {
    expect(usd(12.5)).toBe('$12.50');
  });

  it('formats a negative value with the sign before the $', () => {
    expect(usd(-3.4)).toBe('-$3.40');
  });

  it.each([undefined, null, NaN])('falls back to "No data" for %p', (n) => {
    expect(usd(n)).toBe('No data');
  });
});

describe('sol', () => {
  it('formats a value to 4 decimals with a unit suffix', () => {
    expect(sol(1.5)).toBe('1.5000 SOL');
  });

  it.each([undefined, null, NaN])('falls back to "No data" for %p', (n) => {
    expect(sol(n)).toBe('No data');
  });
});

describe('pct', () => {
  it('prefixes a positive value with +', () => {
    expect(pct(12.34)).toBe('+12.3%');
  });

  it('does not double up the sign on a negative value', () => {
    expect(pct(-5.6)).toBe('-5.6%');
  });

  it('treats exactly 0 as non-negative', () => {
    expect(pct(0)).toBe('+0.0%');
  });

  it.each([undefined, null, NaN])('falls back to "No data" for %p', (n) => {
    expect(pct(n)).toBe('No data');
  });
});

describe('percent', () => {
  it('never adds a sign, unlike pct — for plain proportions like holder concentration', () => {
    expect(percent(63)).toBe('63%');
    expect(percent(0)).toBe('0%');
  });

  it.each([undefined, null, NaN])('falls back to "No data" for %p', (n) => {
    expect(percent(n)).toBe('No data');
  });
});

describe('numberOrFallback', () => {
  it('renders a real zero as "0", not the fallback', () => {
    expect(numberOrFallback(0, 'No data')).toBe('0');
  });

  it.each([undefined, null, NaN])('uses the caller-provided fallback for %p', (n) => {
    expect(numberOrFallback(n, 'No data')).toBe('No data');
  });
});

describe('lamportsToSol', () => {
  it('converts a lamports string to SOL', () => {
    expect(lamportsToSol('2500000000')).toBe(2.5);
  });

  it('returns undefined for null/undefined', () => {
    expect(lamportsToSol(null)).toBeUndefined();
    expect(lamportsToSol(undefined)).toBeUndefined();
  });

  it('returns undefined instead of throwing on malformed input', () => {
    expect(lamportsToSol('not-a-number')).toBeUndefined();
  });
});

describe('timeAgo', () => {
  it('formats minutes for a recent timestamp', () => {
    expect(timeAgo(new Date(Date.now() - 5 * 60_000).toISOString())).toBe('5m ago');
  });

  it('formats hours and minutes for a same-day timestamp', () => {
    expect(timeAgo(new Date(Date.now() - (2 * 60 + 15) * 60_000).toISOString())).toBe('2h 15m ago');
  });

  it('returns "never" for null/undefined/malformed input rather than "Invalid Date ago"', () => {
    expect(timeAgo(null)).toBe('never');
    expect(timeAgo(undefined)).toBe('never');
    expect(timeAgo('not-a-date')).toBe('never');
  });
});

describe('pnlToneClass', () => {
  it('is success for non-negative values', () => {
    expect(pnlToneClass(0)).toBe('text-success');
    expect(pnlToneClass(5)).toBe('text-success');
  });

  it('is danger for negative values', () => {
    expect(pnlToneClass(-1)).toBe('text-danger');
  });

  it.each([undefined, null, NaN])('is neutral for %p', (n) => {
    expect(pnlToneClass(n)).toBe('text-text-primary');
  });
});
