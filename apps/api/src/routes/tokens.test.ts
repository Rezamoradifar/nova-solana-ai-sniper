import { describe, expect, it } from 'vitest';
import { listQuerySchema } from './tokens.js';

describe('tokens listQuerySchema', () => {
  it.each(['PUMPFUN', 'PUMPSWAP', 'RAYDIUM', 'ORCA', 'METEORA', 'JUPITER'])(
    'regression: accepts %s — the full live Dex enum, not a stale hand-copied subset',
    (dex) => {
      // Previously PUMPSWAP and METEORA were missing from a hand-written literal
      // list here, so a valid `/tokens?dex=PUMPSWAP` or `?dex=METEORA` request
      // 400'd even though both are real, supported DEXs.
      const result = listQuerySchema.safeParse({ dex });
      expect(result.success).toBe(true);
    },
  );

  it('rejects a dex value that is not a real Dex enum member', () => {
    const result = listQuerySchema.safeParse({ dex: 'NOT_A_REAL_DEX' });
    expect(result.success).toBe(false);
  });

  it('dex filter is optional', () => {
    const result = listQuerySchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('defaults limit to 50 and rejects out-of-range values', () => {
    expect(listQuerySchema.parse({}).limit).toBe(50);
    expect(listQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
    expect(listQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
    expect(listQuerySchema.safeParse({ limit: '100' }).success).toBe(true);
  });
});
