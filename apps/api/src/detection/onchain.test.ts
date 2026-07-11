import { PublicKey } from '@solana/web3.js';
import { describe, expect, it, vi } from 'vitest';
import { getHolderConcentration } from './onchain.js';

function fakeAccount(address: string, amount: string) {
  return {
    address: new PublicKey(address),
    amount,
    decimals: 9,
    uiAmount: null,
    uiAmountString: amount,
  };
}

// Real-looking distinct base58 pubkeys — content doesn't matter, only distinctness.
const WHALE = '5S5RY1DK3qaX2qGNwzkZzgvvzMASwMHYQuTabYu3noNm';
const VAULT_A = '8mLaS8AGuwGDtSPohmHZZaymz29hNhcvjn34tSTgY6ZR';
const VAULT_B = 'DEa3pR1wv2nNVJ69MKgiGkeVV1GyFJ8wbt6QQ6V1Hei8';
const HOLDER_1 = '2777smtvybXugRsrJWc57SBfFg3avKHzXsT8aX4VgqYx';

describe('getHolderConcentration', () => {
  it('excludes the given vault addresses from both the top-10 sum and the holder count', async () => {
    const connection = {
      getTokenLargestAccounts: vi.fn().mockResolvedValue({
        value: [
          fakeAccount(VAULT_A, '600'), // pool vault — should be excluded
          fakeAccount(VAULT_B, '200'), // second pool vault — should be excluded
          fakeAccount(WHALE, '100'),
          fakeAccount(HOLDER_1, '50'),
        ],
      }),
      getTokenSupply: vi.fn().mockResolvedValue({ value: { amount: '1000' } }),
    };

    const result = await getHolderConcentration(
      connection as never,
      '8Jexwtd8Py1g2bkjhQXPXoSztf5WEBAHvdLb7gUmpump',
      [VAULT_A, VAULT_B],
    );

    // Only the two real holders remain: (100 + 50) / 1000 = 15%
    expect(result.top10HolderPercent).toBe(15);
    expect(result.holderCount).toBe(2);
  });

  it('behaves exactly as before when no addresses are excluded', async () => {
    const connection = {
      getTokenLargestAccounts: vi.fn().mockResolvedValue({
        value: [fakeAccount(WHALE, '900'), fakeAccount(HOLDER_1, '100')],
      }),
      getTokenSupply: vi.fn().mockResolvedValue({ value: { amount: '1000' } }),
    };

    const result = await getHolderConcentration(
      connection as never,
      '8Jexwtd8Py1g2bkjhQXPXoSztf5WEBAHvdLb7gUmpump',
    );

    expect(result.top10HolderPercent).toBe(100);
    expect(result.holderCount).toBe(2);
  });

  it('returns zero rather than dividing by zero when total supply is 0', async () => {
    const connection = {
      getTokenLargestAccounts: vi.fn().mockResolvedValue({ value: [] }),
      getTokenSupply: vi.fn().mockResolvedValue({ value: { amount: '0' } }),
    };

    const result = await getHolderConcentration(
      connection as never,
      '8Jexwtd8Py1g2bkjhQXPXoSztf5WEBAHvdLb7gUmpump',
    );

    expect(result).toEqual({ top10HolderPercent: 0, holderCount: 0 });
  });
});
