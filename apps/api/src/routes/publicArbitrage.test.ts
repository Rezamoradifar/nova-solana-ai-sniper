import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import publicArbitrageRoutes, { buildPublicArbitrageReport } from './publicArbitrage.js';
import {
  setActiveArbitrageScanner,
  type ArbitrageReport,
  type ArbitrageScanner,
} from '../trading/arbitrageScanner.js';

const now = 1_000_000;
const config = { enabled: true, intervalMs: 90_000 };
function snapshot(overrides: Partial<ArbitrageReport> = {}): ArbitrageReport {
  const roundTrip = {
    mint: 'TokenMint',
    buyDex: 'Raydium',
    sellDex: 'Whirlpool',
    at: now - 10_000,
    inSol: 0.5,
    outSol: 0.497,
    grossSol: -0.003,
    netSol: -0.003705,
  };
  return {
    enabled: true,
    mode: 'paper',
    scans: 1,
    quotesOk: 4,
    quotesFailed: 0,
    opportunities: 0,
    paperNetSol: 9000,
    bestNetSol: undefined,
    lastScanAt: now - 5_000,
    lastQuoteAt: now - 5_000,
    sessionStartedAt: now - 60_000,
    running: true,
    scanInProgress: false,
    configuration: {
      amountSol: 0.5,
      estimatedCostSol: 0.000205,
      slippageBufferBps: 10,
      minEstimatedNetSol: 0.0005,
      dexes: ['Raydium', 'Whirlpool'],
      mints: ['TokenMint'],
    },
    recent: [],
    lastByMint: { TokenMint: roundTrip },
    ...overrides,
  };
}

afterEach(() => setActiveArbitrageScanner(undefined));

describe('public arbitrage observations', () => {
  it('reports disabled with no fabricated statistics or historical results', () => {
    const data = buildPublicArbitrageReport({ ...config, enabled: false }, snapshot(), now);
    expect(data).toMatchObject({
      status: 'disabled',
      counts: null,
      configuration: null,
      latest: [],
      recent: [],
    });
  });

  it('distinguishes an enabled setting from a scanner that is actually running', () => {
    expect(buildPublicArbitrageReport(config, undefined, now).status).toBe('unavailable');
    expect(buildPublicArbitrageReport(config, snapshot({ running: false }), now).status).toBe(
      'unavailable',
    );
  });

  it('reports the first scan as starting, then unavailable if it never produces data', () => {
    const pending = snapshot({ scans: 0, lastByMint: {}, scanInProgress: true });
    expect(buildPublicArbitrageReport(config, pending, now).status).toBe('starting');
    expect(buildPublicArbitrageReport(config, pending, now + 180_001).status).toBe('unavailable');
  });

  it('does not call a completed scan ready when it has no round-trip quotes', () => {
    const data = buildPublicArbitrageReport(
      config,
      snapshot({ lastByMint: { TokenMint: null }, quotesFailed: 4 }),
      now,
    );
    expect(data).toMatchObject({ status: 'unavailable', reason: 'no_round_trip_quotes' });
  });

  it('can be ready with negative estimates and zero opportunities', () => {
    const data = buildPublicArbitrageReport(config, snapshot(), now);
    expect(data).toMatchObject({ status: 'ready', mode: 'observation', executionEnabled: false });
    expect(data.latest[0]).toMatchObject({
      estimatedNetSol: -0.003705,
      meetsThreshold: false,
      fresh: true,
    });
    expect(data).not.toHaveProperty('paperNetSol');
    expect(data.counts?.opportunityObservations).toBe(0);
  });

  it('uses quote age rather than the scan-completion time when reporting stale data', () => {
    const data = buildPublicArbitrageReport(
      config,
      snapshot({ lastScanAt: now + 200_000 }),
      now + 200_000,
    );
    expect(data).toMatchObject({ status: 'stale', reason: 'quotes_stale' });
    expect(data.latest[0]).toMatchObject({ fresh: false, ageMs: 210_000 });
  });

  it('allowlists every public object and caps recent observations', () => {
    const report = snapshot();
    const row = { ...report.lastByMint.TokenMint!, walletId: 'DO_NOT_RETURN' };
    const internal = {
      ...report,
      apiKey: 'DO_NOT_RETURN',
      configuration: { ...report.configuration, rpcUrl: 'DO_NOT_RETURN' },
      lastByMint: { TokenMint: row },
      recent: Array.from({ length: 50 }, () => row),
    };
    const data = buildPublicArbitrageReport(config, internal, now);
    expect(data.recent).toHaveLength(12);
    expect(JSON.stringify(data)).not.toContain('DO_NOT_RETURN');
    expect(JSON.stringify(data)).not.toContain('paperNetSol');
  });

  it('allows anonymous GET without executing a quote or exposing application configuration', async () => {
    const scanOnce = vi.fn();
    const report = vi.fn(() => snapshot());
    setActiveArbitrageScanner({ report, scanOnce } as unknown as ArbitrageScanner);
    const app = Fastify();
    app.decorate('config', {
      ARBITRAGE_SCANNER_ENABLED: true,
      ARBITRAGE_INTERVAL_MS: 90_000,
      JWT_SECRET: 'DO_NOT_RETURN',
    } as never);
    await app.register(publicArbitrageRoutes);
    try {
      const response = await app.inject('/public/arbitrage');
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.json()).toMatchObject({ executionEnabled: false, source: 'Jupiter' });
      expect(response.body).not.toContain('DO_NOT_RETURN');
      expect(report).toHaveBeenCalledOnce();
      expect(scanOnce).not.toHaveBeenCalled();
      expect((await app.inject({ method: 'POST', url: '/public/arbitrage' })).statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
