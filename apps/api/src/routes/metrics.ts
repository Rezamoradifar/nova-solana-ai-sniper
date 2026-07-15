import type { FastifyInstance } from 'fastify';
import { metrics } from '../lib/metrics.js';
import { computeLatencyReport } from '../lib/latencyTracker.js';
import {
  rpcRequestCounters,
  rpcLatencyRegistry,
  rpcCooldownRegistry,
} from '../solana/resilientConnection.js';

export default async function metricsRoutes(fastify: FastifyInstance) {
  fastify.get('/metrics', async () => metrics.snapshot());

  // Latency Optimization Stage 1 (2026-07-14) — objective 2's "latency
  // report," read-only over the in-process rolling window of recent trades
  // (see latencyTracker.ts). No auth beyond whatever this app's other
  // internal-stats routes already have; carries no user/wallet-identifying
  // data (mint/walletId/positionId are internal IDs, not secrets).
  fastify.get('/metrics/latency', async () => computeLatencyReport());

  // 2026-07-15 Helius credit audit — per-provider RPC request/retry/rate-limit
  // visibility that previously only existed as unlabeled warn-level log lines
  // (see resilientConnection.ts's RpcRequestCounters doc comment), plus
  // per-DEX discovery-source liveness (see SourceHealthMonitor.snapshot) and
  // WebSocket subscription status. Answers "which provider, how many
  // requests/sec, how many rate-limited/retried, is each discovery source
  // still receiving events" directly.
  fastify.get('/metrics/rpc', async () => {
    const requests = rpcRequestCounters.snapshot();
    return {
      requests,
      latencyMsByProvider: rpcLatencyRegistry.snapshot(),
      cooldownUntilByProvider: rpcCooldownRegistry.snapshot(),
      // Helius doesn't expose a real-time credit balance via API — this is a
      // proxy (raw request count to the Helius provider label), not an
      // authoritative credit count. Every request Helius receives (including
      // ones it later 429s) still costs against quota, so this undercounts
      // true consumption whenever Helius itself is the rate-limiting provider.
      estimatedHeliusRequests: {
        note: 'proxy metric: raw request count to the "helius" provider label, not an authoritative credit count',
        count: requests.attemptsByProvider['helius'] ?? 0,
      },
      discoverySourceHealth: fastify.sourceHealthMonitor?.snapshot() ?? {},
      webSocketSubscriptions: {
        // Every real-time discovery source (pump.fun + the 4 native DEXs) binds
        // its onLogs subscription to the primary provider only (see
        // resilientConnection.ts's SUBSCRIPTION_METHODS doc comment) — reported
        // as connected once the worker has started, since a dropped underlying
        // socket surfaces as discoverySourceHealth going silent, not as a
        // distinct connection-state flag today.
        status: fastify.sourceHealthMonitor ? 'connected' : 'not_started',
      },
    };
  });
}
