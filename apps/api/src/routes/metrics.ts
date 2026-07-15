import type { FastifyInstance } from 'fastify';
import { metrics } from '../lib/metrics.js';
import { computeLatencyReport } from '../lib/latencyTracker.js';
import { rpcRequestCounters, rpcLatencyRegistry } from '../solana/resilientConnection.js';

export default async function metricsRoutes(fastify: FastifyInstance) {
  fastify.get('/metrics', async () => metrics.snapshot());

  // Latency Optimization Stage 1 (2026-07-14) — objective 2's "latency
  // report," read-only over the in-process rolling window of recent trades
  // (see latencyTracker.ts). No auth beyond whatever this app's other
  // internal-stats routes already have; carries no user/wallet-identifying
  // data (mint/walletId/positionId are internal IDs, not secrets).
  fastify.get('/metrics/latency', async () => computeLatencyReport());

  // 2026-07-15 429 investigation — per-provider RPC request/rate-limit
  // visibility that previously only existed as unlabeled warn-level log lines
  // (see resilientConnection.ts's RpcRequestCounters doc comment). Answers
  // "which provider, how many requests/sec, how many rate-limited" directly.
  fastify.get('/metrics/rpc', async () => ({
    requests: rpcRequestCounters.snapshot(),
    latencyMsByProvider: rpcLatencyRegistry.snapshot(),
  }));
}
