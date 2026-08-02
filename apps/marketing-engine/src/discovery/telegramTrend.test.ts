import { describe, expect, it } from 'vitest';
import { extractMintCandidates, isValidMintFormat } from './telegramTrend.js';

// Same real (trimmed) sample fragments as apps/api/src/social/telegramTrend.test.ts —
// this module is a deliberate duplicate (see telegramTrend.ts's own doc comment), so its
// extraction behavior must match exactly.
const TRENDINGSSOL_SAMPLE = `<a href="https://t.me/GigaChadSol" target="_blank">GIGACHAD</a> Buy!<br/>
<i>0.5893 SOL ($45.92)</i><br/>
<i>20 007.508 GIGA</i><br/>
<a href="https://solscan.io/address/3ACp4T3ptTdayzWryEhT65NKZSKLjwXviBjWEy54aFdW" target="_blank">3ACp4T...aFdW</a> |
<a href="https://solscan.io/tx/5ednUpuXcLR36cUQi2ui6yDAwZE168GYvZhSco7F6BSTajDba93mB76iSHLjxXKi18iZLJDugzG1R7259jbPAUtd" target="_blank">Txn</a><br/>
<a href="https://dexscreener.com/solana/63LfDmNb3MQ8mw9MtZ2To9bEA2M71kZUUGq5tiJxcqj9" target="_blank">Chart</a>
<a href="https://t.me/trendingssol" target="_blank">Trending</a>`;

const TRENDING_SAMPLE = `<b>325.86% Increase!</b><br/>
Token: <a href="https://solscan.io/token/Bu3hbyUd9qgDWv4vrrKDk3mWR8LDcs7tiZrmjRrzpump" target="_blank">baby febu</a><br/>
<a href="https://www.dextools.io/app/en/solana/pair-explorer/BFq1LpwAN5M7fTwtqVaN4LgmaSWK7x3G4uDt14UGYEgw" target="_blank">DexT</a>
<a href="https://dexscreener.com/solana/bfq1lpwan5m7ftwtqvan4lgmaswk7x3g4udt14ugyegw" target="_blank">Screener</a>
<a href="https://jup.ag/swap/SOL-Bu3hbyUd9qgDWv4vrrKDk3mWR8LDcs7tiZrmjRrzpump" target="_blank">Buy</a>`;

describe('extractMintCandidates', () => {
  it('extracts the mint from a dexscreener chart link and ignores the buyer wallet + tx signature', () => {
    const candidates = extractMintCandidates(TRENDINGSSOL_SAMPLE);
    expect(candidates).toContain('63LfDmNb3MQ8mw9MtZ2To9bEA2M71kZUUGq5tiJxcqj9');
    expect(candidates).not.toContain('3ACp4T3ptTdayzWryEhT65NKZSKLjwXviBjWEy54aFdW');
    expect(candidates.some((c) => c.startsWith('5ednUpuXcLR'))).toBe(false);
  });

  it('extracts the correctly-cased mint from solscan.io/token and jup.ag/swap links', () => {
    const candidates = extractMintCandidates(TRENDING_SAMPLE);
    expect(candidates).toContain('Bu3hbyUd9qgDWv4vrrKDk3mWR8LDcs7tiZrmjRrzpump');
  });

  it('deduplicates the same mint referenced by more than one link pattern', () => {
    const candidates = extractMintCandidates(TRENDING_SAMPLE);
    const occurrences = candidates.filter(
      (c) => c === 'Bu3hbyUd9qgDWv4vrrKDk3mWR8LDcs7tiZrmjRrzpump',
    );
    expect(occurrences).toHaveLength(1);
  });

  it('extracts a bare address following a CA:/Contract:/Mint: label', () => {
    const html = '<div>New gem! CA: 63LfDmNb3MQ8mw9MtZ2To9bEA2M71kZUUGq5tiJxcqj9 🚀</div>';
    expect(extractMintCandidates(html)).toContain('63LfDmNb3MQ8mw9MtZ2To9bEA2M71kZUUGq5tiJxcqj9');
  });

  it('returns nothing for a message with no address at all', () => {
    expect(extractMintCandidates('<div>Congrats to all our winners today! 🎉</div>')).toEqual([]);
  });

  it('excludes SOL_MINT even when linked as if it were a token', () => {
    const html =
      '<a href="https://dexscreener.com/solana/So11111111111111111111111111111111111111112">Chart</a>';
    expect(extractMintCandidates(html)).toEqual([]);
  });

  it('rejects a candidate that is not a valid base58 public key', () => {
    expect(isValidMintFormat('0OIl00000000000000000000000000000000000000')).toBe(false);
  });
});
