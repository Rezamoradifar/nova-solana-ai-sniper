import { describe, expect, it } from 'vitest';
import {
  classifyCopyReadiness,
  type PublicCopyReadiness,
  type PublicNetworkReadiness,
} from './realReadiness.js';

const healthyNetwork: PublicNetworkReadiness = {
  status: 'ready', tradingMode: 'LIVE', workersReady: true,
};
const healthyCopy: PublicCopyReadiness = {
  executionMode: 'live', liveExecutionEnabled: true,
  copyWatcherReady: true, watcher: { running: true, healthy: true },
};

describe('real copy readiness cannot be inferred from UI previews', () => {
  it('is unavailable without BOTH real API responses', () => {
    expect(classifyCopyReadiness(null, healthyCopy)).toBe('unavailable');
    expect(classifyCopyReadiness(healthyNetwork, null)).toBe('unavailable');
  });
  it('requires a usable mainnet RPC and live background workers', () => {
    expect(classifyCopyReadiness({ ...healthyNetwork, status: 'degraded' }, healthyCopy))
      .toBe('network-degraded');
    expect(classifyCopyReadiness({ ...healthyNetwork, workersReady: false }, healthyCopy))
      .toBe('network-degraded');
  });
  it('never calls paper trading live', () => {
    expect(classifyCopyReadiness({ ...healthyNetwork, tradingMode: 'PAPER' }, healthyCopy))
      .toBe('paper');
    expect(classifyCopyReadiness(healthyNetwork, { ...healthyCopy, executionMode: 'paper' }))
      .toBe('paper');
    expect(classifyCopyReadiness(healthyNetwork, { ...healthyCopy, liveExecutionEnabled: false }))
      .toBe('paper');
  });
  it('requires a running and healthy watcher', () => {
    expect(classifyCopyReadiness(healthyNetwork, { ...healthyCopy, watcher: null }))
      .toBe('watcher-stopped');
    expect(classifyCopyReadiness(healthyNetwork, {
      ...healthyCopy, watcher: { running: true, healthy: false },
    })).toBe('watcher-degraded');
  });
  it('only labels verified public backend state ready', () => {
    expect(classifyCopyReadiness(healthyNetwork, healthyCopy)).toBe('live-backend-ready');
  });
});
