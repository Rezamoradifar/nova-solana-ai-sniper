import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ARB_DEXES,
  ARB_TOKENS,
  QUOTE_FRESH_MS,
  evaluateQuoteCycle,
  isRouteFresh,
  validateQuote,
} from './liveArbitrage.js';
import { SOL_MINT } from './publicMarket.js';

const token = ARB_TOKENS[0];
const amount = 1_000_000_000n;
const dex = ARB_DEXES[0];
function quote(
  inputMint = SOL_MINT,
  outputMint: string = token.mint,
  inputAmount = amount,
  label: string = dex,
) {
  return {
    inputMint,
    inAmount: inputAmount.toString(),
    outputMint,
    outAmount: '1000',
    otherAmountThreshold: '950',
    swapMode: 'ExactIn',
    slippageBps: 50,
    platformFee: null,
    priceImpactPct: '0.0012',
    contextSlot: 360_000_000,
    timeTaken: 0.001,
    // The public response may have bps:null and omit feeAmount/feeMint.
    routePlan: [
      {
        swapInfo: {
          ammKey: 'PoolA',
          label,
          inputMint,
          outputMint,
          inAmount: inputAmount.toString(),
          outAmount: '1000',
          updateContextSlot: '360000000',
        },
        percent: 100,
        bps: null,
      },
    ],
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('Jupiter direct quote validation', () => {
  it('accepts the direct ExactIn response shape with additional API metadata', () => {
    const raw = quote();
    expect(validateQuote(raw, SOL_MINT, token.mint, amount, dex)).toBe(raw);
  });

  it.each([
    { inputMint: 'WrongMint' },
    { inAmount: '999999999' },
    { outAmount: '1.5' },
    { outAmount: '0' },
    { outAmount: '-1' },
    { outAmount: '18446744073709551616' },
    { outAmount: '9'.repeat(400) },
    { otherAmountThreshold: '1001' },
    { otherAmountThreshold: '0' },
    { contextSlot: undefined },
    { contextSlot: NaN },
    { priceImpactPct: 'NaN' },
    { priceImpactPct: '' },
    { routePlan: [] },
  ])('rejects unusable response fields: %j', (invalid) => {
    expect(() =>
      validateQuote({ ...quote(), ...invalid }, SOL_MINT, token.mint, amount, dex),
    ).toThrow('valid direct quote');
  });

  it('rejects a route for another venue even when its outer amounts and mints match', () => {
    expect(() =>
      validateQuote(
        quote(SOL_MINT, token.mint, amount, 'Other DEX'),
        SOL_MINT,
        token.mint,
        amount,
        dex,
      ),
    ).toThrow();
  });
});

describe('integer quote-cycle costs', () => {
  it('rounds fractional slippage reserves up to the next lamport', () => {
    expect(evaluateQuoteCycle(10_001n, 10_002n, 0n, 1)).toEqual({
      grossLamports: 1n,
      bufferLamports: 2n,
      netLamports: -1n,
    });
  });

  it('preserves exact net amounts above JavaScript integer precision', () => {
    const input = 9_007_199_254_740_993n;
    expect(evaluateQuoteCycle(input, input + 3n, 2n, 0).netLamports).toBe(1n);
  });

  it.each([
    [0n, 1n, 0n, 0],
    [1n, -1n, 0n, 0],
    [1n, 1n, -1n, 0],
    [1n, 1n, 0n, -1],
    [1n, 1n, 0n, 0.5],
    [1n, 1n, 0n, 501],
  ] as const)('rejects invalid cost inputs %s / %s / %s / %s', (input, output, cost, bps) => {
    expect(() => evaluateQuoteCycle(input, output, cost, bps)).toThrow('Invalid quote parameters');
  });
});

describe('quote observation freshness', () => {
  it('expires from the earlier quote at the documented boundary', () => {
    const route = { buyQuoteAt: 100_000, observedAt: 110_000 };
    expect(isRouteFresh(route, 100_000 + QUOTE_FRESH_MS)).toBe(true);
    expect(isRouteFresh(route, 100_001 + QUOTE_FRESH_MS)).toBe(false);
  });

  it.each([
    { buyQuoteAt: NaN, observedAt: 100_000 },
    { buyQuoteAt: 90_000, observedAt: Infinity },
    { buyQuoteAt: -1, observedAt: 100_000 },
    { buyQuoteAt: 100_001, observedAt: 100_000 },
    { buyQuoteAt: 90_000, observedAt: 100_001 },
  ])('does not label invalid or future timestamps fresh: %j', (route) => {
    expect(isRouteFresh(route, 100_000)).toBe(false);
  });
});

async function runMockScan(
  options: { staleSell?: boolean; buyLatencyMs?: number; costSol?: number } = {},
) {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  vi.resetModules();
  const module = await import('./liveArbitrage.js');
  const requests: URL[] = [];
  const fetchMock = vi.fn(async (input: string | URL) => {
    const url = new URL(input.toString());
    requests.push(url);
    const inputMint = url.searchParams.get('inputMint')!;
    const outputMint = url.searchParams.get('outputMint')!;
    const rawAmount = BigInt(url.searchParams.get('amount')!);
    const label = url.searchParams.get('dexes')!;
    if (inputMint === SOL_MINT && label !== dex) return new Response('{}', { status: 404 });
    if (inputMint === SOL_MINT && options.buyLatencyMs)
      vi.setSystemTime(Date.now() + options.buyLatencyMs);
    if (inputMint !== SOL_MINT && options.staleSell)
      vi.setSystemTime(Date.now() + module.QUOTE_FRESH_MS + 1);
    const data = quote(inputMint, outputMint, rawAmount, label);
    if (inputMint !== SOL_MINT)
      Object.assign(data, { outAmount: '1005000000', otherAmountThreshold: '1004000000' });
    return new Response(JSON.stringify(data), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  const onRoute = vi.fn();
  const work = module.scanLiveRoutes(
    { token, amountSol: 1, costSol: options.costSol ?? 0.000205, bufferBps: 10 },
    new AbortController().signal,
    vi.fn(),
    onRoute,
  );
  await vi.runAllTimersAsync();
  return { routes: await work, requests, onRoute };
}

describe('read-only scan result safety', () => {
  it('uses minimum output for both legs and reserves fractional configured costs conservatively', async () => {
    const { routes, requests } = await runMockScan({ costSol: 0.0002050004 });
    const sellRequests = requests.filter((r) => r.searchParams.get('inputMint') !== SOL_MINT);
    expect(sellRequests.every((r) => r.searchParams.get('amount') === '950')).toBe(true);
    expect(routes).toHaveLength(2);
    expect(routes[0]).toMatchObject({
      outputSol: 1.004,
      costSol: 0.000205001,
      estimatedNetSol: 0.002794999,
    });
    expect(
      requests.every(
        (r) => r.pathname === '/swap/v1/quote' && r.searchParams.get('onlyDirectRoutes') === 'true',
      ),
    ).toBe(true);
  });

  it('does not emit a route when the earlier quote has expired before the exit quote returns', async () => {
    const { routes, onRoute } = await runMockScan({ staleSell: true });
    expect(routes).toEqual([]);
    expect(onRoute).not.toHaveBeenCalled();
  });

  it('includes buy response latency in the age of an observation', async () => {
    const { routes } = await runMockScan({ buyLatencyMs: 10_000 });
    expect(routes[0]?.buyQuoteAt).toBe(1_000_000);
  });
});
