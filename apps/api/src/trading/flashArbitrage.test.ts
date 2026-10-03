import { describe, expect, it, vi } from 'vitest';
import {
  FlashArbitrageExecutor,
  evaluateFlashArbitrage,
  type FlashArbitrageCandidate,
  type FlashArbitrageRiskConfig,
  type FlashLoanRuntime,
} from './flashArbitrage.js';
import type { QuoteResponse } from '../solana/jupiter.js';

const BASE = 'Base111111111111111111111111111111111111111';
const TOKEN = 'Token11111111111111111111111111111111111111';

function quote(inputMint: string, outputMint: string, input: bigint, minOut: bigint, impact = '0.0005') {
  return {
    inputMint,
    outputMint,
    inAmount: input.toString(),
    outAmount: minOut.toString(),
    otherAmountThreshold: minOut.toString(),
    priceImpactPct: impact,
    routePlan: [],
  } satisfies QuoteResponse;
}

function candidate(overrides: Partial<FlashArbitrageCandidate> = {}): FlashArbitrageCandidate {
  const borrow = 1_000_000_000n;
  const intermediate = 2_000_000_000n;
  const finalOut = 1_006_000_000n;
  return {
    baseMint: BASE,
    intermediateMint: TOKEN,
    borrowAmount: borrow,
    intermediateMinOut: intermediate,
    finalMinOut: finalOut,
    estimatedExecutionCostBaseUnits: 1_000_000n,
    buyDex: 'Raydium CLMM',
    sellDex: 'Whirlpool',
    buyQuoteAt: 1_000,
    sellQuoteAt: 1_100,
    buyQuote: quote(BASE, TOKEN, borrow, intermediate),
    sellQuote: quote(TOKEN, BASE, intermediate, finalOut),
    ...overrides,
  };
}

const config: FlashArbitrageRiskConfig = {
  maxBorrowBaseUnits: 10_000_000_000n,
  minNetBps: 30,
  maxPriceImpactBps: 25,
  maxQuoteAgeMs: 5_000,
  liveExecutionEnabled: false,
};

describe('evaluateFlashArbitrage', () => {
  it('uses both guaranteed minimum outputs and subtracts the execution-cost reserve', () => {
    const result = evaluateFlashArbitrage(candidate(), config, 1_500);
    expect(result).toEqual({
      accepted: true,
      reason: 'ok',
      guaranteedNetBaseUnits: 5_000_000n,
      guaranteedNetBps: 50,
      worstPriceImpactBps: 5,
    });
  });

  it('rejects stale quotes, excessive impact, insufficient edge and over-limit borrowing', () => {
    expect(evaluateFlashArbitrage(candidate(), config, 7_000).reason).toBe('stale_quote');
    expect(
      evaluateFlashArbitrage(
        candidate({ buyQuote: quote(BASE, TOKEN, 1_000_000_000n, 2_000_000_000n, '0.01') }),
        config,
        1_500,
      ).reason,
    ).toBe('price_impact');
    expect(
      evaluateFlashArbitrage(candidate({ finalMinOut: 1_002_000_000n, sellQuote: quote(TOKEN, BASE, 2_000_000_000n, 1_002_000_000n) }), config, 1_500).reason,
    ).toBe('below_minimum_edge');
    expect(
      evaluateFlashArbitrage(
        candidate({
          borrowAmount: 11_000_000_000n,
          buyQuote: quote(BASE, TOKEN, 11_000_000_000n, 2_000_000_000n),
        }),
        config,
        1_500,
      ).reason,
    ).toBe('borrow_limit');
  });

  it('fails closed if quote identity or threshold chaining does not match the candidate', () => {
    expect(
      evaluateFlashArbitrage(
        candidate({ sellQuote: quote(TOKEN, BASE, 1_999_999_999n, 1_006_000_000n) }),
        config,
        1_500,
      ).reason,
    ).toBe('invalid_candidate');
  });
});

describe('FlashArbitrageExecutor', () => {
  function runtime(simulationOk = true): FlashLoanRuntime & {
    buildAtomic: ReturnType<typeof vi.fn>;
    simulate: ReturnType<typeof vi.fn>;
    submit: ReturnType<typeof vi.fn>;
  } {
    return {
      buildAtomic: vi.fn(async () => ({ transaction: { id: 'atomic' }, txSizeBytes: 900, accountLocks: 40 })),
      simulate: vi.fn(async () => ({ ok: simulationOk, error: simulationOk ? undefined : 'simulation failed' })),
      submit: vi.fn(async () => 'signature-123'),
    };
  }

  it('simulates by default and never submits', async () => {
    const rt = runtime();
    const executor = new FlashArbitrageExecutor(rt, config);
    const result = await executor.execute(candidate(), 'SIMULATION', 1_500);
    expect(result.status).toBe('SIMULATED');
    expect(rt.buildAtomic).toHaveBeenCalledOnce();
    expect(rt.simulate).toHaveBeenCalledOnce();
    expect(rt.submit).not.toHaveBeenCalled();
  });

  it('never submits a transaction whose simulation failed', async () => {
    const rt = runtime(false);
    const executor = new FlashArbitrageExecutor(rt, { ...config, liveExecutionEnabled: true });
    const result = await executor.execute(candidate(), 'LIVE', 1_500);
    expect(result.status).toBe('SIMULATION_FAILED');
    expect(rt.submit).not.toHaveBeenCalled();
  });

  it('requires a separate LIVE gate even after profitability passes', async () => {
    const rt = runtime();
    const executor = new FlashArbitrageExecutor(rt, config);
    await expect(executor.execute(candidate(), 'LIVE', 1_500)).rejects.toThrow(/disabled/);
    expect(rt.buildAtomic).not.toHaveBeenCalled();
  });

  it('submits only after profitability and simulation both pass with LIVE explicitly enabled', async () => {
    const rt = runtime();
    const executor = new FlashArbitrageExecutor(rt, { ...config, liveExecutionEnabled: true });
    const result = await executor.execute(candidate(), 'LIVE', 1_500);
    expect(result).toMatchObject({ status: 'SUBMITTED', signature: 'signature-123' });
    expect(rt.buildAtomic).toHaveBeenCalledOnce();
    expect(rt.simulate).toHaveBeenCalledOnce();
    expect(rt.submit).toHaveBeenCalledOnce();
  });

  it('does not build or simulate candidates rejected by the profitability gate', async () => {
    const rt = runtime();
    const executor = new FlashArbitrageExecutor(rt, config);
    const bad = candidate({ finalMinOut: 1_000_000_000n, sellQuote: quote(TOKEN, BASE, 2_000_000_000n, 1_000_000_000n) });
    const result = await executor.execute(bad, 'SIMULATION', 1_500);
    expect(result.status).toBe('REJECTED');
    expect(rt.buildAtomic).not.toHaveBeenCalled();
    expect(rt.simulate).not.toHaveBeenCalled();
  });
});
