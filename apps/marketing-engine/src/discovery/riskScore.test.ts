import { PublicKey } from '@solana/web3.js';
import { MintLayout, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { describe, expect, it } from 'vitest';
import { computeEcosystemRiskScore, resolveEcosystemRpcUrl, scoreTokenRisk } from './riskScore.js';

const MINT = '8Jexwtd8Py1g2bkjhQXPXoSztf5WEBAHvdLb7gUmpump';

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

describe('resolveEcosystemRpcUrl', () => {
  it('prefers Helius when an API key is configured', () => {
    expect(resolveEcosystemRpcUrl({ heliusApiKey: 'abc' })).toBe(
      'https://mainnet.helius-rpc.com/?api-key=abc',
    );
  });

  it('falls back to the raw rpcUrl when no Helius key is set', () => {
    expect(resolveEcosystemRpcUrl({ rpcUrl: 'https://custom.example/rpc' })).toBe(
      'https://custom.example/rpc',
    );
  });

  it('falls back to the public default when nothing is configured', () => {
    expect(resolveEcosystemRpcUrl({})).toBe('https://api.mainnet-beta.solana.com');
  });
});

describe('computeEcosystemRiskScore', () => {
  const safe = {
    mintAuthorityRevoked: true,
    freezeAuthorityRevoked: true,
    top10HolderPercent: 10,
    liquidityUsd: 50_000,
  };

  it('scores a fully-safe token near 100', () => {
    expect(computeEcosystemRiskScore(safe)).toBe(100);
  });

  it('penalizes an un-revoked mint authority the heaviest', () => {
    expect(computeEcosystemRiskScore({ ...safe, mintAuthorityRevoked: false })).toBe(60);
  });

  it('penalizes an un-revoked freeze authority', () => {
    expect(computeEcosystemRiskScore({ ...safe, freezeAuthorityRevoked: false })).toBe(80);
  });

  it('penalizes high holder concentration in tiers', () => {
    expect(computeEcosystemRiskScore({ ...safe, top10HolderPercent: 40 })).toBe(88);
    expect(computeEcosystemRiskScore({ ...safe, top10HolderPercent: 60 })).toBe(75);
  });

  it('penalizes thin liquidity', () => {
    expect(computeEcosystemRiskScore({ ...safe, liquidityUsd: 100 })).toBe(85);
  });

  it('never goes below 0 even with every penalty stacked', () => {
    expect(
      computeEcosystemRiskScore({
        mintAuthorityRevoked: false,
        freezeAuthorityRevoked: false,
        top10HolderPercent: 90,
        liquidityUsd: 0,
      }),
    ).toBe(0);
  });
});

describe('scoreTokenRisk', () => {
  it('returns a score and flags for a genuinely safe token', async () => {
    const data = encodeMintAccount({
      mintAuthority: null,
      freezeAuthority: null,
      supply: 1_000_000_000n,
      decimals: 6,
    });
    const connection = {
      getAccountInfo: async () => ({ owner: TOKEN_PROGRAM_ID, data }),
      getTokenLargestAccounts: async () => ({
        value: [fakeAccount('5S5RY1DK3qaX2qGNwzkZzgvvzMASwMHYQuTabYu3noNm', '100')],
      }),
    } as never;

    const result = await scoreTokenRisk(connection, MINT, 20_000);

    expect(result).toBeDefined();
    expect(result?.flags.mintAuthorityRevoked).toBe(true);
    expect(result?.score).toBe(100);
  });

  it('falls back to Token-2022 the same way onchain.ts does, instead of misreading every Token-2022 mint as unrevoked', async () => {
    const data = encodeMintAccount({
      mintAuthority: null,
      freezeAuthority: null,
      supply: 990_000_000n,
      decimals: 6,
    });
    const getAccountInfo = async () => ({ owner: TOKEN_2022_PROGRAM_ID, data });
    const connection = {
      getAccountInfo,
      getTokenLargestAccounts: async () => ({ value: [] }),
    } as never;

    const result = await scoreTokenRisk(connection, MINT, 20_000);

    expect(result?.flags.mintAuthorityRevoked).toBe(true);
  });

  it('fails closed (returns undefined) rather than posting an unverified score when the RPC read errors', async () => {
    const connection = {
      getAccountInfo: async () => null,
      getTokenLargestAccounts: async () => ({ value: [] }),
    } as never;

    const result = await scoreTokenRisk(connection, MINT, 20_000);

    expect(result).toBeUndefined();
  });

  it('reflects an un-revoked mint authority in a lower score', async () => {
    const liveAuthority = new PublicKey('5S5RY1DK3qaX2qGNwzkZzgvvzMASwMHYQuTabYu3noNm');
    const data = encodeMintAccount({
      mintAuthority: liveAuthority,
      freezeAuthority: null,
      supply: 1_000_000_000n,
      decimals: 6,
    });
    const connection = {
      getAccountInfo: async () => ({ owner: TOKEN_PROGRAM_ID, data }),
      getTokenLargestAccounts: async () => ({ value: [] }),
    } as never;

    const result = await scoreTokenRisk(connection, MINT, 20_000);

    expect(result?.flags.mintAuthorityRevoked).toBe(false);
    expect(result?.score).toBeLessThan(100);
  });
});
