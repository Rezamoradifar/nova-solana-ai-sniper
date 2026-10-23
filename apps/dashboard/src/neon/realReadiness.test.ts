import { describe, expect, it } from 'vitest';
import {
  classifyCopyReadiness,
  liveCopyBuysReady,
  type PublicCopyReadiness,
  type PublicNetworkReadiness,
} from './realReadiness.js';

const healthyNetwork: PublicNetworkReadiness = {
  status: 'ready',
  tradingMode: 'LIVE',
  workersReady: true,
  scanner: { state: 'HEALTHY', wsHealthy: true, fallbackHealthy: false },
};
const healthyCopy: PublicCopyReadiness = {
  executionMode: 'live',
  liveExecutionEnabled: true,
  copyWatcherReady: true,
  watcher: { running: true, healthy: true },
  buyReadiness: { ready: true, blockers: [], checkedAt: 1 },
};

describe('real copy readiness cannot be inferred from UI previews', () => {
  it('is unavailable without BOTH real API responses', () => {
    expect(classifyCopyReadiness(null, healthyCopy)).toBe('unavailable');
    expect(classifyCopyReadiness(healthyNetwork, null)).toBe('unavailable');
  });
  it('requires a usable mainnet RPC and live background workers', () => {
    expect(classifyCopyReadiness({ ...healthyNetwork, status: 'degraded' }, healthyCopy)).toBe(
      'network-degraded',
    );
    expect(classifyCopyReadiness({ ...healthyNetwork, workersReady: false }, healthyCopy)).toBe(
      'network-degraded',
    );
  });
  it('never calls paper trading live', () => {
    expect(classifyCopyReadiness({ ...healthyNetwork, tradingMode: 'PAPER' }, healthyCopy)).toBe(
      'paper',
    );
    expect(classifyCopyReadiness(healthyNetwork, { ...healthyCopy, executionMode: 'paper' })).toBe(
      'paper',
    );
    expect(
      classifyCopyReadiness(healthyNetwork, { ...healthyCopy, liveExecutionEnabled: false }),
    ).toBe('paper');
  });
  it('requires a running and healthy watcher', () => {
    expect(classifyCopyReadiness(healthyNetwork, { ...healthyCopy, watcher: null })).toBe(
      'watcher-stopped',
    );
    expect(
      classifyCopyReadiness(healthyNetwork, {
        ...healthyCopy,
        watcher: { running: true, healthy: false },
      }),
    ).toBe('watcher-degraded');
  });
  it('only labels verified public backend state ready', () => {
    expect(classifyCopyReadiness(healthyNetwork, healthyCopy)).toBe('live-backend-ready');
    expect(liveCopyBuysReady(healthyCopy)).toBe(true);
  });
  it('does not advertise live buys for a paused or unknown safety state', () => {
    for (const reason of ['BUYING_PAUSED', 'SAFETY_STATE_UNKNOWN']) {
      const copy = {
        ...healthyCopy,
        buyReadiness: { ready: false, blockers: [reason], checkedAt: 1 },
      };
      expect(classifyCopyReadiness(healthyNetwork, copy)).toBe('buy-paused');
      expect(liveCopyBuysReady(copy)).toBe(false);
    }
  });
  it('requires explicit readiness from the backend and rejects contradictory data', () => {
    const legacy = { ...healthyCopy, buyReadiness: undefined };
    expect(classifyCopyReadiness(healthyNetwork, legacy)).toBe('readiness-unavailable');
    expect(liveCopyBuysReady(legacy)).toBe(false);
    const conflict = {
      ...healthyCopy,
      buyReadiness: { ready: true, blockers: ['BUYING_PAUSED'], checkedAt: 1 },
    };
    expect(liveCopyBuysReady(conflict)).toBe(false);
  });
  it('requires scanner health even when the RPC and copy watcher answer normally', () => {
    for (const scanner of [
      null,
      { state: 'UNHEALTHY', wsHealthy: false, fallbackHealthy: false },
      { state: 'HEALTHY', wsHealthy: false, fallbackHealthy: false },
    ]) {
      expect(classifyCopyReadiness({ ...healthyNetwork, scanner }, healthyCopy)).toBe(
        'scanner-degraded',
      );
    }
  });
});
