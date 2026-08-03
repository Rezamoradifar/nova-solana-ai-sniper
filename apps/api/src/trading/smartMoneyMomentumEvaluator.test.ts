import { describe, it, expect, vi } from 'vitest';
import {
  evaluateSmartMoneyAndMomentum,
  type SmartMoneyMomentumDeps,
} from './smartMoneyMomentumEvaluator.js';

function baseDeps(overrides: Partial<SmartMoneyMomentumDeps> = {}): SmartMoneyMomentumDeps {
  return {
    smartWalletTracker: {
      evaluateForToken: vi.fn().mockResolvedValue({
        smartMoneyScore: undefined,
        clusterBuy: { isClusterBuy: false, independentClusterCount: 0, clusterKeys: [] },
        buyEvents: [],
        sybilDiscountApplied: false,
      }),
    } as never,
    earlyMomentumDetector: {
      fetchPair: vi.fn().mockResolvedValue(undefined),
      scoreFromPair: vi.fn().mockReturnValue({ score: 0, breakdown: {}, priceUsd: undefined }),
    } as never,
    logger: { debug: vi.fn(), warn: vi.fn() } as never,
    smartMoneyEnabled: true,
    momentumEnabled: true,
    ...overrides,
  };
}

describe('evaluateSmartMoneyAndMomentum', () => {
  it('returns an empty result immediately when both engines are disabled', async () => {
    const deps = baseDeps({ smartMoneyEnabled: false, momentumEnabled: false });
    const result = await evaluateSmartMoneyAndMomentum(deps, { mint: 'mint1', tokenId: 'token1' });
    expect(result.smartMoneyScore).toBeUndefined();
    expect(result.earlyMomentumScore).toBeUndefined();
    expect(deps.smartWalletTracker.evaluateForToken).not.toHaveBeenCalled();
    expect(deps.earlyMomentumDetector.fetchPair).not.toHaveBeenCalled();
  });

  it('runs wallet evaluation and pair fetch concurrently (both start before either resolves)', async () => {
    const order: string[] = [];
    const deps = baseDeps({
      smartWalletTracker: {
        evaluateForToken: vi.fn().mockImplementation(async () => {
          order.push('wallet-start');
          await new Promise((r) => setTimeout(r, 10));
          order.push('wallet-end');
          return {
            smartMoneyScore: 80,
            clusterBuy: { isClusterBuy: false, independentClusterCount: 1, clusterKeys: ['A'] },
            buyEvents: [
              {
                walletAddress: 'A',
                amountTokenUi: 100,
                signature: 'sig1',
                timestampMs: Date.now(),
              },
            ],
            sybilDiscountApplied: false,
          };
        }),
      } as never,
      earlyMomentumDetector: {
        fetchPair: vi.fn().mockImplementation(async () => {
          order.push('pair-start');
          await new Promise((r) => setTimeout(r, 5));
          order.push('pair-end');
          return undefined;
        }),
        scoreFromPair: vi.fn().mockReturnValue({ score: 42, breakdown: {}, priceUsd: 1.23 }),
      } as never,
    });

    const result = await evaluateSmartMoneyAndMomentum(deps, { mint: 'mint1', tokenId: 'token1' });

    // Both must have started before either finished — proof they ran concurrently, not sequentially.
    expect(order[0]).toBe('wallet-start');
    expect(order[1]).toBe('pair-start');
    expect(result.smartMoneyScore).toBe(80);
    expect(result.earlyMomentumScore).toBe(42);
    expect(result.priceUsd).toBe(1.23);
  });

  it('degrades to undefined scores when a sub-evaluation throws, without throwing itself', async () => {
    const deps = baseDeps({
      smartWalletTracker: {
        evaluateForToken: vi.fn().mockRejectedValue(new Error('rpc failure')),
      } as never,
    });
    const result = await evaluateSmartMoneyAndMomentum(deps, { mint: 'mint1', tokenId: 'token1' });
    expect(result.smartMoneyScore).toBeUndefined();
  });

  it('skips wallet evaluation entirely when smartMoneyEnabled is false', async () => {
    const deps = baseDeps({ smartMoneyEnabled: false });
    await evaluateSmartMoneyAndMomentum(deps, { mint: 'mint1', tokenId: 'token1' });
    expect(deps.smartWalletTracker.evaluateForToken).not.toHaveBeenCalled();
    expect(deps.earlyMomentumDetector.fetchPair).toHaveBeenCalled();
  });

  it('skips momentum evaluation entirely when momentumEnabled is false', async () => {
    const deps = baseDeps({ momentumEnabled: false });
    await evaluateSmartMoneyAndMomentum(deps, { mint: 'mint1', tokenId: 'token1' });
    expect(deps.earlyMomentumDetector.fetchPair).not.toHaveBeenCalled();
    expect(deps.earlyMomentumDetector.scoreFromPair).not.toHaveBeenCalled();
  });
});
