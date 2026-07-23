import { describe, expect, it, vi } from 'vitest';
import type { JupiterClient, QuoteResponse } from '../solana/jupiter.js';
import { checkSellability, MAX_ACCEPTABLE_EXIT_PRICE_IMPACT_PCT } from './sellabilityCheck.js';

function fakeLogger() {
  return { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() } as never;
}

function fakeQuote(overrides: Partial<QuoteResponse> = {}): QuoteResponse {
  return {
    inAmount: '1000000',
    outAmount: '900000',
    priceImpactPct: '0.005',
    routePlan: [],
    ...overrides,
  };
}

describe('checkSellability', () => {
  it('is sellable when a real quote comes back with acceptable price impact', async () => {
    const getQuote = vi.fn().mockResolvedValue(fakeQuote({ priceImpactPct: '0.02' }));
    const jupiter = { getQuote } as unknown as JupiterClient;

    const result = await checkSellability(jupiter, 'MintABC', 1_000_000n, fakeLogger());

    expect(result.sellable).toBe(true);
    expect(result.priceImpactPct).toBeCloseTo(2, 5);
  });

  it('is not sellable when Jupiter finds no route at all', async () => {
    const getQuote = vi
      .fn()
      .mockRejectedValue(new Error('Jupiter quote failed: 400 No routes found'));
    const jupiter = { getQuote } as unknown as JupiterClient;

    const result = await checkSellability(jupiter, 'MintABC', 1_000_000n, fakeLogger());

    expect(result.sellable).toBe(false);
    expect(result.reason).toBe('no_sell_route');
  });

  it('is not sellable when a route exists but exit price impact is too high', async () => {
    // 0.30 fraction = 30%, above MAX_ACCEPTABLE_EXIT_PRICE_IMPACT_PCT (25%).
    const getQuote = vi.fn().mockResolvedValue(fakeQuote({ priceImpactPct: '0.30' }));
    const jupiter = { getQuote } as unknown as JupiterClient;

    const result = await checkSellability(jupiter, 'MintABC', 1_000_000n, fakeLogger());

    expect(result.sellable).toBe(false);
    expect(result.reason).toBe('exit_price_impact_too_high');
    expect(result.priceImpactPct).toBeCloseTo(30, 5);
  });

  it('accepts exactly at the threshold boundary and rejects just above it', async () => {
    const atThreshold = await checkSellability(
      {
        getQuote: vi.fn().mockResolvedValue(fakeQuote({ priceImpactPct: '0.25' })),
      } as unknown as JupiterClient,
      'MintABC',
      1_000_000n,
      fakeLogger(),
    );
    expect(atThreshold.sellable).toBe(true);

    const aboveThreshold = await checkSellability(
      {
        getQuote: vi.fn().mockResolvedValue(fakeQuote({ priceImpactPct: '0.2501' })),
      } as unknown as JupiterClient,
      'MintABC',
      1_000_000n,
      fakeLogger(),
    );
    expect(aboveThreshold.sellable).toBe(false);
    expect(MAX_ACCEPTABLE_EXIT_PRICE_IMPACT_PCT).toBe(25);
  });

  it('is not sellable for a zero/negative estimated amount without ever calling Jupiter', async () => {
    const getQuote = vi.fn();
    const jupiter = { getQuote } as unknown as JupiterClient;

    const result = await checkSellability(jupiter, 'MintABC', 0n, fakeLogger());

    expect(result.sellable).toBe(false);
    expect(result.reason).toBe('no_sell_route');
    expect(getQuote).not.toHaveBeenCalled();
  });

  it('retries a transient (rate-limited) quote failure and succeeds once the request goes through — never reported as a confirmed no-route', async () => {
    const getQuote = vi
      .fn()
      .mockRejectedValueOnce(new Error('Jupiter quote failed: 429 Too Many Requests'))
      .mockResolvedValueOnce(fakeQuote({ priceImpactPct: '0.01' }));
    const jupiter = { getQuote } as unknown as JupiterClient;

    const result = await checkSellability(jupiter, 'MintABC', 1_000_000n, fakeLogger());

    expect(result.sellable).toBe(true);
    expect(getQuote).toHaveBeenCalledTimes(2);
  });

  it('reports a distinct "sellability_check_failed" (unknown) — not "no_sell_route" (confirmed) — when every retry hits a transient request failure', async () => {
    const getQuote = vi.fn().mockRejectedValue(new Error('fetch failed: socket hang up'));
    const jupiter = { getQuote } as unknown as JupiterClient;

    const result = await checkSellability(jupiter, 'MintABC', 1_000_000n, fakeLogger());

    expect(result.sellable).toBe(false);
    expect(result.reason).toBe('sellability_check_failed');
    expect(getQuote).toHaveBeenCalledTimes(3);
  });

  it("does not retry a genuine (non-transient) no-route response — retrying can't manufacture a route that isn't there", async () => {
    const getQuote = vi
      .fn()
      .mockRejectedValue(new Error('Jupiter quote failed: 400 COULD_NOT_FIND_ANY_ROUTE'));
    const jupiter = { getQuote } as unknown as JupiterClient;

    const result = await checkSellability(jupiter, 'MintABC', 1_000_000n, fakeLogger());

    expect(result.sellable).toBe(false);
    expect(result.reason).toBe('no_sell_route');
    expect(getQuote).toHaveBeenCalledTimes(1);
  });
});
