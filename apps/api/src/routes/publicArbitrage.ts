import type { FastifyInstance } from 'fastify';
import {
  getActiveArbitrageScanner,
  type ArbitrageReport,
  type RoundTripReport,
} from '../trading/arbitrageScanner.js';

export type PublicArbitrageStatus = 'disabled' | 'starting' | 'ready' | 'stale' | 'unavailable';

/** Allowlisted observation data only. Reading this report never requests a quote or trade. */
export function buildPublicArbitrageReport(
  config: { enabled: boolean; intervalMs: number },
  report: ArbitrageReport | undefined,
  now = Date.now(),
) {
  const snapshot = config.enabled ? report : undefined;
  // Telemetry freshness relative to the configured polling cadence, not quote validity.
  const freshnessWindowMs = Math.max(30_000, config.intervalMs * 2);
  const row = (r: RoundTripReport) => ({
    mint: r.mint,
    buyDex: r.buyDex,
    sellDex: r.sellDex,
    inputSol: r.inSol,
    outputSol: r.outSol,
    estimatedGrossSol: r.grossSol,
    estimatedNetSol: r.netSol,
    estimatedNetPercent: r.inSol > 0 ? (r.netSol / r.inSol) * 100 : null,
    observedAt: r.at,
    ageMs: Math.max(0, now - r.at),
    fresh: r.at <= now && now - r.at <= freshnessWindowMs,
    meetsThreshold: r.netSol >= (snapshot?.configuration.minEstimatedNetSol ?? Infinity),
  });
  const latest = Object.values(snapshot?.lastByMint ?? {}).flatMap((r) => (r ? [row(r)] : []));
  let status: PublicArbitrageStatus;
  let reason: string | null = null;
  if (!config.enabled) {
    status = 'disabled';
    reason = 'disabled_by_configuration';
  } else if (!snapshot?.running) {
    status = 'unavailable';
    reason = 'scanner_not_running';
  } else if (latest.some((r) => r.fresh)) {
    status = 'ready';
  } else if (latest.length > 0) {
    status = 'stale';
    reason = 'quotes_stale';
  } else if (snapshot.scans === 0 && now - snapshot.sessionStartedAt <= freshnessWindowMs) {
    status = 'starting';
    reason = 'awaiting_first_scan';
  } else {
    status = 'unavailable';
    reason = snapshot.scans === 0 ? 'first_scan_delayed' : 'no_round_trip_quotes';
  }
  const settings = snapshot?.configuration;
  return {
    enabled: config.enabled,
    status,
    reason,
    mode: 'observation' as const,
    executionEnabled: false as const,
    source: 'Jupiter' as const,
    updatedAt: now,
    lastScanAt: snapshot?.lastScanAt ?? null,
    lastQuoteAt: snapshot?.lastQuoteAt ?? null,
    sessionStartedAt: snapshot?.sessionStartedAt ?? null,
    freshnessWindowMs,
    scanInProgress: snapshot?.scanInProgress ?? false,
    configuration: settings
      ? {
          amountSol: settings.amountSol,
          estimatedCostSol: settings.estimatedCostSol,
          slippageBufferBps: settings.slippageBufferBps,
          minEstimatedNetSol: settings.minEstimatedNetSol,
          dexes: [...settings.dexes],
          mints: [...settings.mints],
        }
      : null,
    counts: snapshot
      ? {
          scans: snapshot.scans,
          quotesOk: snapshot.quotesOk,
          quotesFailed: snapshot.quotesFailed,
          // Repeated observations may describe the same opportunity; never realized PnL.
          opportunityObservations: snapshot.opportunities,
        }
      : null,
    latest,
    recent: (snapshot?.recent ?? []).slice(0, 12).map(row),
  };
}

export default async function publicArbitrageRoutes(fastify: FastifyInstance) {
  fastify.get(
    '/public/arbitrage',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (_request, reply) => {
      reply.header('Cache-Control', 'no-store');
      return buildPublicArbitrageReport(
        {
          enabled: fastify.config.ARBITRAGE_SCANNER_ENABLED,
          intervalMs: fastify.config.ARBITRAGE_INTERVAL_MS,
        },
        getActiveArbitrageScanner()?.report(),
      );
    },
  );
}
