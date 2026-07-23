import { PublicKey } from '@solana/web3.js';
import { MintLayout, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { describe, expect, it, vi } from 'vitest';
import { getHolderConcentration, getMintAuthorityInfo } from './onchain.js';

function encodeMintAccount(opts: {
  mintAuthority: PublicKey | null;
  freezeAuthority: PublicKey | null;
  supply: bigint;
  decimals: number;
}): Buffer {
  const buf = Buffer.alloc(MintLayout.span);
  MintLayout.encode(
    {
      mintAuthorityOption: opts.mintAuthority ? 1 : 0,
      mintAuthority: opts.mintAuthority ?? PublicKey.default,
      supply: opts.supply,
      decimals: opts.decimals,
      isInitialized: true,
      freezeAuthorityOption: opts.freezeAuthority ? 1 : 0,
      freezeAuthority: opts.freezeAuthority ?? PublicKey.default,
    },
    buf,
  );
  return buf;
}

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
    };

    const result = await getHolderConcentration(
      connection as never,
      '8Jexwtd8Py1g2bkjhQXPXoSztf5WEBAHvdLb7gUmpump',
      1000n,
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
    };

    const result = await getHolderConcentration(
      connection as never,
      '8Jexwtd8Py1g2bkjhQXPXoSztf5WEBAHvdLb7gUmpump',
      1000n,
    );

    expect(result.top10HolderPercent).toBe(100);
    expect(result.holderCount).toBe(2);
  });

  it('returns zero rather than dividing by zero when total supply is 0', async () => {
    const connection = {
      getTokenLargestAccounts: vi.fn().mockResolvedValue({ value: [] }),
    };

    const result = await getHolderConcentration(
      connection as never,
      '8Jexwtd8Py1g2bkjhQXPXoSztf5WEBAHvdLb7gUmpump',
      0n,
    );

    expect(result).toEqual({ top10HolderPercent: 0, holderCount: 0 });
  });
});

describe('getMintAuthorityInfo', () => {
  const MINT = '8Jexwtd8Py1g2bkjhQXPXoSztf5WEBAHvdLb7gUmpump';

  it('reads a legacy SPL Token mint on the first attempt, without probing Token-2022', async () => {
    const data = encodeMintAccount({
      mintAuthority: null,
      freezeAuthority: null,
      supply: 1_000_000_000n,
      decimals: 6,
    });
    const getAccountInfo = vi.fn().mockResolvedValue({ owner: TOKEN_PROGRAM_ID, data });
    const connection = { getAccountInfo } as never;

    const result = await getMintAuthorityInfo(connection, MINT);

    expect(result).toEqual({
      mintAuthorityRevoked: true,
      freezeAuthorityRevoked: true,
      decimals: 6,
      supply: 1_000_000_000n,
    });
    expect(getAccountInfo).toHaveBeenCalledTimes(1);
  });

  it('production incident (2026-07-22 audit): falls back to Token-2022 and reads the real authority state instead of throwing/failing closed — every live pump.fun mint sampled was Token-2022 and got misread as "not revoked" before this fix', async () => {
    const data = encodeMintAccount({
      mintAuthority: null,
      freezeAuthority: null,
      supply: 990_419_924_896_407n,
      decimals: 6,
    });
    // First call (legacy program assumption) returns the account with the
    // WRONG owner recorded — exactly what a real Token-2022 mint looks like
    // to a caller that assumed TOKEN_PROGRAM_ID.
    const getAccountInfo = vi.fn().mockResolvedValue({ owner: TOKEN_2022_PROGRAM_ID, data });
    const connection = { getAccountInfo } as never;

    const result = await getMintAuthorityInfo(connection, MINT);

    expect(result).toEqual({
      mintAuthorityRevoked: true,
      freezeAuthorityRevoked: true,
      decimals: 6,
      supply: 990_419_924_896_407n,
    });
    // Two RPC calls: the legacy-program attempt, then the Token-2022 retry.
    expect(getAccountInfo).toHaveBeenCalledTimes(2);
  });

  it('correctly reports an un-revoked Token-2022 mint as genuinely unsafe, not confusing "different program" with "different verdict"', async () => {
    const liveAuthority = new PublicKey('5S5RY1DK3qaX2qGNwzkZzgvvzMASwMHYQuTabYu3noNm');
    const data = encodeMintAccount({
      mintAuthority: liveAuthority,
      freezeAuthority: null,
      supply: 1_000_000_000n,
      decimals: 6,
    });
    const getAccountInfo = vi.fn().mockResolvedValue({ owner: TOKEN_2022_PROGRAM_ID, data });
    const connection = { getAccountInfo } as never;

    const result = await getMintAuthorityInfo(connection, MINT);

    expect(result.mintAuthorityRevoked).toBe(false);
    expect(result.freezeAuthorityRevoked).toBe(true);
  });

  it('propagates a genuine failure (account not found on either program) rather than silently returning a fabricated verdict', async () => {
    const getAccountInfo = vi.fn().mockResolvedValue(null);
    const connection = { getAccountInfo } as never;

    await expect(getMintAuthorityInfo(connection, MINT)).rejects.toThrow();
  });
});
