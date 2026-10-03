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

function scanner(
  prices: Record<string, { buy: bigint; sell: bigint }>,
  minNet = 0n,
  quoteGapMs = 0,
) {
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
      quoteGapMs,
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

  it('quotes each ordered pair and never sells on the same DEX as the matching buy', async () => {
    const { s, quote } = scanner({ A: { buy: 1000n, sell: 1n }, B: { buy: 900n, sell: 1n } });
    await s.scanOnce();
    expect(quote.mock.calls.map(([p]) => [p.inputMint, p.dexes, p.amountLamports])).toEqual([
      [SOL_MINT, ['A'], 1_000_000_000n],
      [MINT, ['B'], 1000n],
      [SOL_MINT, ['B'], 1_000_000_000n],
      [MINT, ['A'], 900n],
    ]);
  });

  it('finds a better round trip even when it starts with fewer tokens', async () => {
    const { s } = scanner({
      A: { buy: 1100n, sell: 1_200_000_000n },
      B: { buy: 1000n, sell: 700_000_000n },
    });
    const [best] = await s.scanOnce();
    // Greedily selecting A's larger buy would miss B -> A and only observe a loss.
    expect(best).toMatchObject({ buyDex: 'B', sellDex: 'A', netLamports: 199_800_000n });
  });

  it.each(['not-a-number', '0', '-1'])(
    'counts invalid quote output %s only as failure',
    async (outAmount) => {
      const { s, quote } = scanner({
        A: { buy: 1000n, sell: 1_000_000_000n },
        B: { buy: 1000n, sell: 1_000_000_000n },
      });
      quote.mockResolvedValueOnce({ outAmount, inAmount: '', priceImpactPct: '0', routePlan: [] });
      await s.scanOnce();
      const report = s.report();
      expect(report.quotesFailed).toBe(1);
      expect(report.quotesOk).toBe(2);
      expect(report.quotesOk + report.quotesFailed).toBe(quote.mock.calls.length);
    },
  );

  it('dates a result from its buy request rather than its later sell response', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      const { s, quote } = scanner({
        A: { buy: 1100n, sell: 700_000_000n },
        B: { buy: 1000n, sell: 1_200_000_000n },
      });
      const original = quote.getMockImplementation()!;
      quote.mockImplementation(async (params) => {
        vi.setSystemTime(Date.now() + 1_000);
        return original(params);
      });
      const [best] = await s.scanOnce();
      expect(best).toMatchObject({ buyDex: 'A', sellDex: 'B', at: 1_000 });
      expect(s.report().lastQuoteAt).toBe(5_000);
      expect(s.report().lastByMint[MINT]?.at).toBe(1_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not request another quote or commit a result after stopping during the first buy', async () => {
    const { s, quote } = scanner({
      A: { buy: 1000n, sell: 1_100_000_000n },
      B: { buy: 1000n, sell: 1_100_000_000n },
    });
    const response = { outAmount: '1000', inAmount: '', priceImpactPct: '0', routePlan: [] };
    let release!: (value: typeof response) => void;
    quote.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const pending = s.scanOnce(); // A one-off scan is supported without start().
    expect(quote).toHaveBeenCalledOnce();
    s.stop();
    release(response);
    expect(await pending).toEqual([]);
    expect(quote).toHaveBeenCalledOnce();
    expect(s.report()).toMatchObject({
      scans: 0,
      quotesOk: 0,
      quotesFailed: 0,
      opportunities: 0,
      recent: [],
      lastByMint: {},
      lastScanAt: undefined,
      lastQuoteAt: undefined,
    });
    // Stopping one generation does not disable future explicit one-off scans.
    expect(await s.scanOnce()).toHaveLength(1);
    expect(s.report().scans).toBe(1);
  });

  it('cancels a quote-gap wait immediately without starting the next request', async () => {
    vi.useFakeTimers();
    const { s, quote } = scanner(
      { A: { buy: 1000n, sell: 1n }, B: { buy: 900n, sell: 1n } },
      0n,
      60_000,
    );
    try {
      const pending = s.scanOnce();
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(1);
      s.stop();
      expect(await pending).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
      expect(quote).toHaveBeenCalledOnce();
      expect(s.report()).toMatchObject({ scans: 0, opportunities: 0, lastByMint: {} });
    } finally {
      s.stop();
      vi.useRealTimers();
    }
  });

  it('does not let an old scan clear the running flag after a restart', async () => {
    vi.useFakeTimers();
    const { s, quote } = scanner({ A: { buy: 1000n, sell: 1n }, B: { buy: 900n, sell: 1n } });
    const response = { outAmount: '1000', inAmount: '', priceImpactPct: '0', routePlan: [] };
    let releaseOld!: (value: typeof response) => void;
    let releaseNew!: (value: typeof response) => void;
    quote.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseOld = resolve;
        }),
    );
    quote.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseNew = resolve;
        }),
    );
    try {
      s.start(1_000);
      s.stop();
      s.start(1_000);
      expect(quote).toHaveBeenCalledTimes(2);
      releaseOld(response);
      await vi.advanceTimersByTimeAsync(0);
      expect(s.report().scanInProgress).toBe(true);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(quote).toHaveBeenCalledTimes(2);
      s.stop();
      releaseNew(response);
      await vi.advanceTimersByTimeAsync(0);
      expect(s.report()).toMatchObject({
        scans: 0,
        quotesOk: 0,
        opportunities: 0,
        running: false,
        scanInProgress: false,
      });
    } finally {
      s.stop();
      vi.useRealTimers();
    }
  });
});
