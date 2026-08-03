/**
 * Massive Scanner Scalability (Phase 2, 2026-07-26) — benchmarks the actual
 * mechanism this phase changed: PriorityConcurrencyQueue's throughput under a
 * synthetic burst of candidates, comparing today's fixed concurrency against
 * ScannerConcurrencyGovernor's dynamic scaling. Deliberately entirely
 * in-memory (no real RPC/Jupiter/DB calls, no network) — this is a live-money
 * trading system, and there is no safe way to fire a real burst of concurrent
 * RPC calls at production infrastructure just to produce a benchmark number.
 * The synthetic handler's per-item latency is calibrated to this codebase's
 * own measured reality: candidatePipeline.ts's own concurrent
 * riskAnalyzer.analyze()/Jupiter-quote calls (see candidatePipeline.ts's
 * Promise.allSettled block) typically resolve in the 200-600ms range against
 * Helius/DexScreener/Jupiter in production logs.
 *
 * Usage:
 *   npm run benchmark-scanner --workspace apps/api
 *   npm run benchmark-scanner --workspace apps/api -- --items=500 --latencyMs=400
 */
import { PriorityConcurrencyQueue } from '../src/lib/priorityQueue.js';
import { ScannerConcurrencyGovernor } from '../src/detection/scannerConcurrencyGovernor.js';
import { PerfMonitor } from '../src/lib/perfMonitor.js';

function arg(name: string, fallback: number): number {
  const match = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!match) return fallback;
  const value = Number(match.split('=')[1]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const ITEMS = arg('items', 300);
const LATENCY_MS = arg('latencyMs', 400);
const FIXED_CONCURRENCY = arg('fixedConcurrency', 8);
const MIN_CONCURRENCY = arg('minConcurrency', 2);
const MAX_CONCURRENCY = arg('maxConcurrency', 24);
const GOVERNOR_INTERVAL_MS = arg('governorIntervalMs', 500);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A little jitter (±25%) so the run isn't a perfectly uniform, unrealistic
 * lockstep — real RPC/AI-provider latency varies per call. */
function jitteredLatency(): number {
  const jitter = LATENCY_MS * 0.25;
  return Math.max(1, LATENCY_MS + (Math.random() * 2 - 1) * jitter);
}

async function runFixedConcurrency(): Promise<{ elapsedMs: number; throughputPerSec: number }> {
  let completed = 0;
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  const queue = new PriorityConcurrencyQueue<number>(FIXED_CONCURRENCY, async () => {
    await sleep(jitteredLatency());
    completed++;
    if (completed === ITEMS) resolveDone();
  });

  const startedAt = Date.now();
  for (let i = 0; i < ITEMS; i++) queue.enqueue(i);
  await done;
  const elapsedMs = Date.now() - startedAt;
  return { elapsedMs, throughputPerSec: Math.round((ITEMS / elapsedMs) * 1000 * 100) / 100 };
}

async function runDynamicConcurrency(): Promise<{
  elapsedMs: number;
  throughputPerSec: number;
  finalConcurrency: number;
}> {
  let completed = 0;
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  const queue = new PriorityConcurrencyQueue<number>(MIN_CONCURRENCY, async () => {
    await sleep(jitteredLatency());
    completed++;
    if (completed === ITEMS) resolveDone();
  });

  const perfMonitor = new PerfMonitor();
  const governor = new ScannerConcurrencyGovernor(
    {
      queue,
      perfMonitor,
      logger: { debug() {}, info() {}, warn() {}, error() {} } as never,
      // Benchmark harness: no real RPC layer exists, so there is never a
      // primary-provider cooldown to react to here — this run only exercises
      // the backlog-driven scale-up/idle scale-down side of the governor.
      primaryProviderLabel: 'benchmark',
    },
    {
      intervalMs: GOVERNOR_INTERVAL_MS,
      minConcurrency: MIN_CONCURRENCY,
      maxConcurrency: MAX_CONCURRENCY,
      eventLoopLagCeilingMs: 5_000, // effectively disabled for this synthetic run
    },
  );
  governor.start();

  const startedAt = Date.now();
  for (let i = 0; i < ITEMS; i++) queue.enqueue(i);
  await done;
  const elapsedMs = Date.now() - startedAt;
  const finalConcurrency = governor.snapshot().concurrency;
  governor.stop();

  return {
    elapsedMs,
    throughputPerSec: Math.round((ITEMS / elapsedMs) * 1000 * 100) / 100,
    finalConcurrency,
  };
}

async function main() {
  console.log(
    `Benchmarking PriorityConcurrencyQueue: ${ITEMS} items, ~${LATENCY_MS}ms simulated per-item latency\n`,
  );

  const fixed = await runFixedConcurrency();
  console.log(
    `Fixed concurrency (${FIXED_CONCURRENCY}, today's default):  ${fixed.elapsedMs}ms total, ${fixed.throughputPerSec} items/sec`,
  );

  const dynamic = await runDynamicConcurrency();
  console.log(
    `Dynamic concurrency (governor, ${MIN_CONCURRENCY}-${MAX_CONCURRENCY}):  ${dynamic.elapsedMs}ms total, ${dynamic.throughputPerSec} items/sec (settled at concurrency=${dynamic.finalConcurrency})`,
  );

  const speedup = Math.round((fixed.elapsedMs / dynamic.elapsedMs) * 100) / 100;
  console.log(`\n${speedup}x faster wall-clock time to drain the same burst.`);
}

void main();
