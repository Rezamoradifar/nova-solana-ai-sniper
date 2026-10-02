import { describe, expect, it, vi } from 'vitest';
import { ArbitrageScanner, evaluateRoundTrip } from './arbitrageScanner.js';
import { SOL_MINT, type QuoteParams } from '../solana/jupiter.js';

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
const MINT = 'TokenMint1111111111111111111111111111111111';

describe('evaluateRoundTrip', () => {
  it('subtracts cost and the slippage buffer from the gross gap', () => {
    const r = evaluateRoundTrip(1_000_000_000n, 1_002_000_000n, 200_000n, 10);
    expect(r.grossLamports).toBe(2_000_000n);
    expect(r.netLamports).toBe(2_000_000n - 200_000n - 1_000_000n);
  });
});

function scanner(prices: Record<string, { buy: bigint; sell: bigint }>, minNet = 0n) {
  const quote = vi.fn(async (p: QuoteParams) => {
    const dex = p.dexes![0]!;
    if (p.inputMint === SOL_MINT)
      return {
        outAmount: String(prices[dex]!.buy),
        inAmount: '',
        priceImpactPct: '0',
        routePlan: [],
      };
    // sell: SOL out proportional to tokens in, at this DEX's sell rate per 1000 tokens
    return {
      outAmount: String((p.amountLamports * prices[dex]!.sell) / 1000n),
      inAmount: '',
      priceImpactPct: '0',
      routePlan: [],
    };
  });
  const s = new ArbitrageScanner(
    { quote, logger },
    {
      mints: [MINT],
      dexes: Object.keys(prices),
      amountLamports: 1_000_000_000n,
      costLamports: 200_000n,
      slippageBufferBps: 0,
      minNetLamports: minNet,
      quoteGapMs: 0,
    },
  );
  return { s, quote };
}

describe('ArbitrageScanner', () => {
  it('buys on the DEX giving the most tokens and sells on the best other DEX', async () => {
    const { s } = scanner({
      A: { buy: 1000n, sell: 990_000_000n },
      B: { buy: 1010n, sell: 1_000_000_000n },
      C: { buy: 990n, sell: 999_000_000n },
    });
    const [best] = await s.scanOnce();
    expect(best!.buyDex).toBe('B');
    expect(best!.sellDex).toBe('C');
    // 1010 tokens * 0.999 SOL/1000 = 1.00899 SOL back
    expect(best!.outLamports).toBe(1_008_990_000n);
    expect(s.report().opportunities).toBe(1);
    expect(s.report().paperNetSol).toBeCloseTo(0.00879, 5);
  });

  it('records nothing when the round trip loses after costs', async () => {
    const { s } = scanner({
      A: { buy: 1000n, sell: 1_000_000_000n },
      B: { buy: 1000n, sell: 1_000_000_000n },
    });
    await s.scanOnce();
    expect(s.report().opportunities).toBe(0);
    expect(s.report().lastByMint[MINT]!.netSol).toBeLessThan(0);
  });

  it('never quotes a sell on the same DEX it bought on, and only direct single-DEX routes', async () => {
    const { s, quote } = scanner({ A: { buy: 1000n, sell: 1n }, B: { buy: 900n, sell: 1n } });
    await s.scanOnce();
    const sells = quote.mock.calls.map((c) => c[0]).filter((p) => p.inputMint !== SOL_MINT);
    expect(sells.map((p) => p.dexes)).toEqual([['B']]);
  });
});
