import { describe, expect, it, vi } from 'vitest';
import {
  loadOwnedOpenPosition,
  manualPartialSellAmount,
  nextManualTierIndex,
  partialSellSchema,
} from './positions.js';

describe('partialSellSchema', () => {
  it('accepts percents in (0, 100)', () => {
    expect(partialSellSchema.safeParse({ percent: 1 }).success).toBe(true);
    expect(partialSellSchema.safeParse({ percent: 50 }).success).toBe(true);
    expect(partialSellSchema.safeParse({ percent: 99 }).success).toBe(true);
  });

  it('rejects 0, 100, and negative percents — a partial sell can never be a no-op or a full close', () => {
    expect(partialSellSchema.safeParse({ percent: 0 }).success).toBe(false);
    expect(partialSellSchema.safeParse({ percent: 100 }).success).toBe(false);
    expect(partialSellSchema.safeParse({ percent: -10 }).success).toBe(false);
  });
});

describe('manualPartialSellAmount', () => {
  it('computes the floor of remaining * percent/100, same raw-unit convention as Position.amountToken', () => {
    expect(manualPartialSellAmount(1000, 25)).toBe(250);
    expect(manualPartialSellAmount(999, 50)).toBe(499);
  });

  it('never sells more than what remains, even at the 99% ceiling', () => {
    expect(manualPartialSellAmount(100, 99)).toBeLessThan(100);
  });
});

describe('nextManualTierIndex', () => {
  it('starts at -1 for the first manual sell on a position', () => {
    expect(nextManualTierIndex(0)).toBe(-1);
  });

  it("produces a strictly negative, incrementing sequence that can never collide with the institutional ladder's non-negative tier indices", () => {
    expect(nextManualTierIndex(1)).toBe(-2);
    expect(nextManualTierIndex(2)).toBe(-3);
    for (let manualSellsSoFar = 0; manualSellsSoFar < 20; manualSellsSoFar++) {
      expect(nextManualTierIndex(manualSellsSoFar)).toBeLessThan(0);
    }
  });
});

function fakeFastify(position: unknown) {
  return {
    prisma: {
      position: {
        findUnique: vi.fn().mockResolvedValue(position),
      },
    },
  } as never;
}

describe('loadOwnedOpenPosition', () => {
  it('returns the position when it exists, is OPEN, and belongs to the requesting user', async () => {
    const position = { id: 'p1', status: 'OPEN', wallet: { userId: 'user-1' } };
    const result = await loadOwnedOpenPosition(fakeFastify(position), 'user-1', 'p1');
    expect(result).toEqual({ position });
  });

  it('returns 404 when the position does not exist', async () => {
    const result = await loadOwnedOpenPosition(fakeFastify(null), 'user-1', 'missing');
    expect(result).toEqual({ error: 404 });
  });

  it('returns 404 when the position belongs to a different user — never leaks existence to a non-owner', async () => {
    const position = { id: 'p1', status: 'OPEN', wallet: { userId: 'someone-else' } };
    const result = await loadOwnedOpenPosition(fakeFastify(position), 'user-1', 'p1');
    expect(result).toEqual({ error: 404 });
  });

  it('returns 409 for a position that is already CLOSED — the exact case that must not double-sell', async () => {
    const position = { id: 'p1', status: 'CLOSED', wallet: { userId: 'user-1' } };
    const result = await loadOwnedOpenPosition(fakeFastify(position), 'user-1', 'p1');
    expect(result).toEqual({ error: 409 });
  });
});
