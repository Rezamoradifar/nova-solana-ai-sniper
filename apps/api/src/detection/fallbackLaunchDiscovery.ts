import type { Connection, ConfirmedSignatureInfo } from '@solana/web3.js';
import type { PrismaClient } from '@prisma/client';
import type { Logger } from '@nova/shared';
import { PUMPFUN_PROGRAM_ID, isCreateInstruction } from '../solana/pumpfun.js';
import { extractMintFromParsedTx } from './extractMint.js';
import { metrics } from '../lib/metrics.js';

export interface FallbackCandidate {
  mint: string;
  deployerAddress?: string;
}

export interface FallbackLaunchDiscoveryDeps {
  connection: Connection;
  prisma: PrismaClient;
  logger: Logger;
  /**
   * Feeds a discovered candidate through the exact same mandatory pipeline
   * every other discovery source uses (see worker.ts's
   * runCandidateThroughPipeline) — this module never evaluates or buys
   * anything itself, it only finds mints the WS path may have missed.
   */
  onCandidate: (candidate: FallbackCandidate) => void | Promise<void>;
}

export interface FallbackLaunchDiscoveryOptions {
  /** How often the cheap idle tick runs — always on, regardless of WS health. */
  idleIntervalMs?: number;
  /** How often an active scan runs while in "fallback" mode (WS unhealthy). */
  activeIntervalMs?: number;
  /** Bounds how far back an active scan will page, regardless of watermark age. */
  maxLookbackMs?: number;
  /** Pagination safety net independent of the time-based cap above. */
  maxSignaturesPerScan?: number;
}

export interface FallbackHealthSnapshot {
  lastIdleTickAt: number | undefined;
  lastActiveScanAt: number | undefined;
  lastActiveScanCompletedAt: number | undefined;
  consecutiveFailures: number;
  /** The one signal scannerHealth.ts needs: this path's own RPC connectivity
   * is confirmed working (proven by the idle tick), independent of whether
   * the WS subscription is healthy. */
  reachable: boolean;
  fallbackModeActive: boolean;
}

export interface ActiveScanResult {
  signaturesScanned: number;
  candidatesFound: number;
  duplicatesRejected: number;
}

const DEFAULT_IDLE_INTERVAL_MS = 60_000;
const DEFAULT_ACTIVE_INTERVAL_MS = 15_000;
const DEFAULT_MAX_LOOKBACK_MS = 2 * 60 * 60 * 1000;
const DEFAULT_MAX_SIGNATURES_PER_SCAN = 5_000;
const SIGNATURES_PAGE_SIZE = 1_000;

/** Fee payer of a parsed transaction — same convention worker.ts's
 * resolveDeployerAddress already uses for the WS path. */
function resolveDeployerAddress(tx: {
  transaction: { message: { accountKeys: Array<{ pubkey: { toBase58(): string } }> } };
}): string | undefined {
  return tx.transaction.message.accountKeys[0]?.pubkey.toBase58();
}

/**
 * Independent fallback discovery for new pump.fun token launches, over plain
 * request/response RPC calls (`getSignaturesForAddress`/`getParsedTransaction`)
 * — never the WS `onLogs` subscription PumpFunMonitor uses, so a WS-side
 * outage can never take this path down with it (2026-07-23, recurring
 * silent-drop incident follow-up).
 *
 * Two distinct costs, deliberately kept separate: `idleTick` is one cheap
 * `getSignaturesForAddress` call (no per-signature parsing) that runs
 * continuously just to prove this path's own RPC connectivity and keep its
 * watermark from drifting far behind — this is the "fallback verified
 * healthy" signal scannerHealth.ts needs for DEGRADED. `activeScan` is the
 * expensive per-signature-parse path (one `getParsedTransaction` per
 * candidate signature) — pumpfun.ts's own doc comment already documented why
 * paying that for every one of the pump.fun program's ~2,300 signatures/min
 * continuously is unaffordable; this only runs it while actually needed
 * (fallback mode, while the WS source is unhealthy) or once, bounded, right
 * after a reconnect to reconcile the outage window.
 */
export class FallbackLaunchDiscovery {
  private idleTimer: ReturnType<typeof setInterval> | undefined;
  private activeTimer: ReturnType<typeof setInterval> | undefined;
  private readonly opts: Required<FallbackLaunchDiscoveryOptions>;

  /** Newest signature fully processed so far — in-memory only, same
   * "restart re-checks once, harmless" convention as MigrationMonitor. */
  private watermarkSignature: string | undefined;
  private scanning = false;

  private lastIdleTickAt: number | undefined;
  private lastActiveScanAt: number | undefined;
  private lastActiveScanCompletedAt: number | undefined;
  private consecutiveFailures = 0;
  private reachable = false;

  constructor(
    private readonly deps: FallbackLaunchDiscoveryDeps,
    options?: FallbackLaunchDiscoveryOptions,
  ) {
    this.opts = {
      idleIntervalMs: options?.idleIntervalMs ?? DEFAULT_IDLE_INTERVAL_MS,
      activeIntervalMs: options?.activeIntervalMs ?? DEFAULT_ACTIVE_INTERVAL_MS,
      maxLookbackMs: options?.maxLookbackMs ?? DEFAULT_MAX_LOOKBACK_MS,
      maxSignaturesPerScan: options?.maxSignaturesPerScan ?? DEFAULT_MAX_SIGNATURES_PER_SCAN,
    };
  }

  /** Always-on cheap liveness probe — starts alongside every other monitor. */
  start(): void {
    if (this.idleTimer) return;
    void this.idleTick();
    this.idleTimer = setInterval(() => void this.idleTick(), this.opts.idleIntervalMs);
    this.idleTimer.unref?.();
  }

  stop(): void {
    if (this.idleTimer) clearInterval(this.idleTimer);
    if (this.activeTimer) clearInterval(this.activeTimer);
    this.idleTimer = undefined;
    this.activeTimer = undefined;
  }

  /** Entered by scannerHealth.ts when the WS source is confirmed unhealthy —
   * this is the actual "independent fallback discovery" running while it's
   * actually needed. No-op if already active. */
  startFallbackMode(): void {
    if (this.activeTimer) return;
    this.activeTimer = setInterval(
      () => void this.activeScan('fallback'),
      this.opts.activeIntervalMs,
    );
    this.activeTimer.unref?.();
  }

  stopFallbackMode(): void {
    if (this.activeTimer) clearInterval(this.activeTimer);
    this.activeTimer = undefined;
  }

  get fallbackModeActive(): boolean {
    return this.activeTimer !== undefined;
  }

  /** Cheap: one signature-list call, no per-signature parsing. Confirms this
   * path's own RPC connectivity and advances the watermark if it's never been
   * set, so a later active scan's lookback window starts bounded rather than
   * "since forever." */
  private async idleTick(): Promise<void> {
    try {
      const [head] = await this.deps.connection.getSignaturesForAddress(PUMPFUN_PROGRAM_ID, {
        limit: 1,
      });
      this.lastIdleTickAt = Date.now();
      this.reachable = true;
      this.consecutiveFailures = 0;
      if (this.watermarkSignature === undefined && head) {
        this.watermarkSignature = head.signature;
      }
    } catch (err) {
      this.consecutiveFailures += 1;
      this.reachable = false;
      this.deps.logger.warn({ err }, 'fallback launch discovery: idle tick failed');
    }
  }

  /**
   * Pages backward from the current head down to the stored watermark (or a
   * bounded lookback/signature-count cap, whichever hits first), classifies
   * each new signature the same way the WS path does (`isCreateInstruction`
   * on the parsed tx's log messages), and feeds every genuine Create through
   * `onCandidate` — which routes it through the identical mandatory security
   * pipeline every other discovery source uses. Bounded and safe to call
   * repeatedly; never throws (best-effort, matches every other interval-
   * driven monitor in this codebase).
   */
  async activeScan(reason: 'fallback' | 'reconciliation'): Promise<ActiveScanResult> {
    const empty: ActiveScanResult = {
      signaturesScanned: 0,
      candidatesFound: 0,
      duplicatesRejected: 0,
    };
    if (this.scanning) return empty;
    this.scanning = true;
    this.lastActiveScanAt = Date.now();

    try {
      const untilSignature = this.watermarkSignature;
      const lookbackFloorMs = Date.now() - this.opts.maxLookbackMs;
      const collected: ConfirmedSignatureInfo[] = [];
      let before: string | undefined;

      for (;;) {
        const batch = await this.deps.connection.getSignaturesForAddress(PUMPFUN_PROGRAM_ID, {
          limit: SIGNATURES_PAGE_SIZE,
          until: untilSignature,
          before,
        });
        if (batch.length === 0) break;
        collected.push(...batch);

        const oldest = batch[batch.length - 1]!;
        const hitLookbackFloor = (oldest.blockTime ?? Date.now() / 1000) * 1000 < lookbackFloorMs;
        const hitScanCap = collected.length >= this.opts.maxSignaturesPerScan;
        if (batch.length < SIGNATURES_PAGE_SIZE || hitLookbackFloor || hitScanCap) break;
        before = oldest.signature;
      }

      // Oldest-first, so a real outage's launches are (re)discovered roughly
      // in the order they actually happened.
      const chronological = [...collected].reverse();
      let candidatesFound = 0;
      let duplicatesRejected = 0;
      const mintsSeenThisScan = new Set<string>();

      for (const sigInfo of chronological) {
        if (sigInfo.err) continue;

        const tx = await this.deps.connection.getParsedTransaction(sigInfo.signature, {
          maxSupportedTransactionVersion: 0,
        });
        if (!tx?.meta?.logMessages || !isCreateInstruction(tx.meta.logMessages)) continue;

        const mint = extractMintFromParsedTx(tx);
        if (!mint) continue;

        if (mintsSeenThisScan.has(mint)) {
          duplicatesRejected += 1;
          metrics.increment('duplicateCandidatesRejectedFallback');
          continue;
        }
        const existing = await this.deps.prisma.token.findUnique({ where: { mint } });
        if (existing) {
          duplicatesRejected += 1;
          metrics.increment('duplicateCandidatesRejectedFallback');
          continue;
        }

        mintsSeenThisScan.add(mint);
        candidatesFound += 1;
        metrics.increment(
          reason === 'reconciliation' ? 'reconciledMissedLaunches' : 'fallbackDiscoveries',
        );
        await this.deps.onCandidate({ mint, deployerAddress: resolveDeployerAddress(tx) });
      }

      if (collected.length > 0) {
        this.watermarkSignature = collected[0]!.signature;
      }
      this.reachable = true;
      this.consecutiveFailures = 0;
      this.lastActiveScanCompletedAt = Date.now();
      this.deps.logger.info(
        { reason, signaturesScanned: chronological.length, candidatesFound, duplicatesRejected },
        'fallback launch discovery: active scan complete',
      );
      return { signaturesScanned: chronological.length, candidatesFound, duplicatesRejected };
    } catch (err) {
      this.consecutiveFailures += 1;
      this.reachable = false;
      this.deps.logger.error({ err, reason }, 'fallback launch discovery: active scan failed');
      return empty;
    } finally {
      this.scanning = false;
    }
  }

  /** Convenience wrapper for scannerHealth.ts — an explicit, one-shot,
   * bounded reconciliation pass over the just-ended outage window. */
  async runReconciliation(): Promise<ActiveScanResult> {
    return this.activeScan('reconciliation');
  }

  getHealth(): FallbackHealthSnapshot {
    return {
      lastIdleTickAt: this.lastIdleTickAt,
      lastActiveScanAt: this.lastActiveScanAt,
      lastActiveScanCompletedAt: this.lastActiveScanCompletedAt,
      consecutiveFailures: this.consecutiveFailures,
      reachable: this.reachable,
      fallbackModeActive: this.fallbackModeActive,
    };
  }
}
