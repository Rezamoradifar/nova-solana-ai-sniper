import { describe, expect, it } from 'vitest';
import { extractMintFromParsedTx } from './extractMint.js';

// Fixtures captured from real mainnet pump.fun `create` transactions (2026-07-10),
// reduced to the pre/postTokenBalances shape this function actually reads.
describe('extractMintFromParsedTx', () => {
  it('resolves a plain create (no prior balance) from postTokenBalances', () => {
    // sig vGkxQJMwpeajsqNUF6PSsJ7kugSG1ztQ1qf4gtX6o4cUAcq99ywdBPsDVsSdQXaAQgQ3wBUr8H3DqDiao82FFR4
    const tx = {
      meta: {
        preTokenBalances: [],
        postTokenBalances: [{ mint: '8Jexwtd8Py1g2bkjhQXPXoSztf5WEBAHvdLb7gUmpump' }],
      },
    };
    expect(extractMintFromParsedTx(tx)).toBe('8Jexwtd8Py1g2bkjhQXPXoSztf5WEBAHvdLb7gUmpump');
  });

  it('resolves a Jito-bundled create+buy where the mint appears in both pre and post balances', () => {
    // sig 2PSVCRxaFYE2pjLcouCmzBz7Sk1kS2LAXPxwtH6PW453qy8AZ6EBPBnfXtQFxAfnjxGcrsHX5PYeNcrctkhRsYcu
    // This is exactly the shape where accountKeys[1] used to resolve to the wrong
    // account — the mint here isn't at global index 1 at all.
    const tx = {
      meta: {
        preTokenBalances: [{ mint: 'GrNhoFEfsfvgir93SY9eBSokvxw9aDCtWD5Rodthpump' }],
        postTokenBalances: [{ mint: 'GrNhoFEfsfvgir93SY9eBSokvxw9aDCtWD5Rodthpump' }],
      },
    };
    expect(extractMintFromParsedTx(tx)).toBe('GrNhoFEfsfvgir93SY9eBSokvxw9aDCtWD5Rodthpump');
  });

  it('resolves another Jito-bundled create the same way', () => {
    // sig 4ekpPCVptSSrpBuYvmZvAysSuY3kFbs23hRp2t58c8tRxq3yefLsx5XZKdACp4pv7m3dHDvzKVVUQ66JLD92vYkG
    const tx = {
      meta: {
        preTokenBalances: [{ mint: 'AVmn4sFiZ8gRhNXSyTRuUJy7pu9S5moTxmBNeckypump' }],
        postTokenBalances: [{ mint: 'AVmn4sFiZ8gRhNXSyTRuUJy7pu9S5moTxmBNeckypump' }],
      },
    };
    expect(extractMintFromParsedTx(tx)).toBe('AVmn4sFiZ8gRhNXSyTRuUJy7pu9S5moTxmBNeckypump');
  });

  it('returns undefined instead of guessing when multiple mints are ambiguous', () => {
    const tx = {
      meta: {
        preTokenBalances: [],
        postTokenBalances: [
          { mint: 'mintA111111111111111111111111111111111111' },
          { mint: 'mintB111111111111111111111111111111111111' },
        ],
      },
    };
    expect(extractMintFromParsedTx(tx)).toBeUndefined();
  });

  it('returns undefined when there are no token balances at all', () => {
    expect(
      extractMintFromParsedTx({ meta: { preTokenBalances: [], postTokenBalances: [] } }),
    ).toBeUndefined();
    expect(extractMintFromParsedTx({ meta: null })).toBeUndefined();
    expect(extractMintFromParsedTx({})).toBeUndefined();
  });
});
