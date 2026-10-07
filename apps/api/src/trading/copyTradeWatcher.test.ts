import { PublicKey, type ParsedTransactionWithMeta } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { detectCopyBuy } from './copyTradeWatcher.js';

const TARGET = '11111111111111111111111111111111';
const TOKEN = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function tx(input: {
  preLamports: number;
  postLamports: number;
  mint: string;
  preToken: number;
  postToken: number;
}): ParsedTransactionWithMeta {
  return {
    transaction: {
      message: {
        accountKeys: [{ pubkey: new PublicKey(TARGET) }],
      },
    },
    meta: {
      preBalances: [input.preLamports],
      postBalances: [input.postLamports],
      preTokenBalances: [
        {
          owner: TARGET,
          mint: input.mint,
          uiTokenAmount: { uiAmount: input.preToken },
        },
      ],
      postTokenBalances: [
        {
          owner: TARGET,
          mint: input.mint,
          uiTokenAmount: { uiAmount: input.postToken },
        },
      ],
    },
  } as unknown as ParsedTransactionWithMeta;
}

describe('detectCopyBuy', () => {
  it('detects a real SOL-funded token balance increase', () => {
    const result = detectCopyBuy(
      tx({
        preLamports: 2_000_000_000,
        postLamports: 1_500_000_000,
        mint: TOKEN,
        preToken: 10,
        postToken: 110,
      }),
      TARGET,
      0.01,
    );

    expect(result).toEqual({
      mint: TOKEN,
      amountSolOriginal: 0.5,
    });
  });

  it('ignores stablecoin balance increases', () => {
    const result = detectCopyBuy(
      tx({
        preLamports: 2_000_000_000,
        postLamports: 1_500_000_000,
        mint: USDC,
        preToken: 10,
        postToken: 110,
      }),
      TARGET,
      0.01,
    );

    expect(result).toBeUndefined();
  });

  it('ignores token changes when source SOL spend is below the configured minimum', () => {
    const result = detectCopyBuy(
      tx({
        preLamports: 2_000_000_000,
        postLamports: 1_995_000_000,
        mint: TOKEN,
        preToken: 0,
        postToken: 100,
      }),
      TARGET,
      0.01,
    );

    expect(result).toBeUndefined();
  });

  it('ignores sells or transfers where target token balance does not increase', () => {
    const result = detectCopyBuy(
      tx({
        preLamports: 2_000_000_000,
        postLamports: 1_500_000_000,
        mint: TOKEN,
        preToken: 100,
        postToken: 20,
      }),
      TARGET,
      0.01,
    );

    expect(result).toBeUndefined();
  });
});
