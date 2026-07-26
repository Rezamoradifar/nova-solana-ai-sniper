import type { Redis } from 'ioredis';
import type { Logger } from '@nova/shared';
import { setScannerAutoBuyPauseState } from '@nova/shared';
import type { NotificationService } from '@nova/telegram-bot';
import type { PumpFunMonitor } from '../solana/pumpfun.js';
import type { ActiveScanResult, FallbackLaunchDiscovery } from './fallbackLaunchDiscovery.js';

export type ScannerHealthState = 'HEALTHY' | 'DEGRADED' | 'RECOVERING' | 'UNHEALTHY';

export interface ScannerHealthDeps {
  pumpFunMonitor: PumpFunMonitor;
  fallbackDiscovery: FallbackLaunchDiscovery;
  redis: Redis;
  logger: Logger;
  notifier?: NotificationService;
}

export interface ScannerHealthOptions {
  checkIntervalMs?: number;
  /** Ceiling on how long RECOVERING will wait for the reconciliation scan to
   * finish before promoting to HEALTHY anyway — a slow/stuck reconciliation
   * must never permanently block recovery. */
  recoveringCeilingMs?: number;
  /**
   * Default false: an UNHEALTHY-triggered auto-buy pause requires an admin to
   * clear it (see safety.ts/scannerAutoBuyPause.ts) rather than
   * auto-resuming the moment detection recovers — matches the task
   * requirement to request admin approval unless policy explicitly allows
   * automatic recovery.
   */
  autoBuyAutoResumeEnabled?: boolean;
}

export interface ScannerHealthSnapshot {
  state: ScannerHealthState;
  stateEnteredAt: number;
  lastHealthyAt: number | undefined;
  wsHealthy: boolean;
  fallbackHealthy: boolean;
  activeProviderLabel: string;
  reconnectCount: number;
  lastReconciliation: ActiveScanResult | undefined;
}

const DEFAULT_CHECK_INTERVAL_MS = 30_000;
const DEFAULT_RECOVERING_CEILING_MS = 5 * 60 * 1000;

/**
 * Scanner-wide health state machine (2026-07-23, recurring pump.fun WS-drop
 * follow-up): combines PumpFunMonitor's own WS-provider health with
 * FallbackLaunchDiscovery's independent-polling health into one of
 * HEALTHY/DEGRADED/RECOVERING/UNHEALTHY, and is the ONLY thing that ever
 * writes the scanner auto-buy pause flag (safety.ts's
 * evaluateScannerAutoBuyPause / packages/shared/src/scannerAutoBuyPause.ts) —
 * set automatically on a confirmed total outage (UNHEALTHY), never cleared
 * automatically on recovery unless `autoBuyAutoResumeEnabled` is explicitly
 * set, matching the task's "request admin approval" default. This never
 * touches SELL/TP/SL/trailing-stop/position monitoring — those don't gate on
 * this flag at all (see safety.ts's checkBeforeOpen, which is buy-only).
 *
 * RECOVERING is a deliberate transitional state: the instant the WS source
 * looks healthy again after being DEGRADED/UNHEALTHY, a bounded gap-
 * reconciliation scan runs (FallbackLaunchDiscovery.runReconciliation) before
 * declaring HEALTHY, so any launches missed during the outage still get a
 * chance to reach the normal pipeline. A stuck/slow reconciliation can never
 * block recovery forever — `recoveringCeilingMs` promotes to HEALTHY anyway
 * once it elapses.
 */
export class ScannerHealthCoordinator {
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly opts: Required<ScannerHealthOptions>;

  private state: ScannerHealthState = 'HEALTHY';
  private stateEnteredAt = Date.now();
  private lastHealthyAt: number | undefined = Date.now();
  private recoveringSince: number | undefined;
  private reconciliationDone = false;
  private lastReconciliation: ActiveScanResult | undefined;

  constructor(
    private readonly deps: ScannerHealthDeps,
    options?: ScannerHealthOptions,
  ) {
    this.opts = {
      checkIntervalMs: options?.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS,
      recoveringCeilingMs: options?.recoveringCeilingMs ?? DEFAULT_RECOVERING_CEILING_MS,
      autoBuyAutoResumeEnabled: options?.autoBuyAutoResumeEnabled ?? false,
    };
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.opts.checkIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  getState(): ScannerHealthState {
    return this.state;
  }

  snapshot(): ScannerHealthSnapshot {
    const pumpFunHealth = this.deps.pumpFunMonitor.getHealth();
    const fallbackHealth = this.deps.fallbackDiscovery.getHealth();
    return {
      state: this.state,
      stateEnteredAt: this.stateEnteredAt,
      lastHealthyAt: this.lastHealthyAt,
      wsHealthy: pumpFunHealth.activeProviderHealthy,
      fallbackHealthy: fallbackHealth.reachable,
      activeProviderLabel: pumpFunHealth.activeProviderLabel,
      reconnectCount: pumpFunHealth.reconnectCount,
      lastReconciliation: this.lastReconciliation,
    };
  }

  async tick(): Promise<void> {
    const pumpFunHealth = this.deps.pumpFunMonitor.getHealth();
    const fallbackHealth = this.deps.fallbackDiscovery.getHealth();
    const wsHealthy = pumpFunHealth.activeProviderHealthy;
    const fallbackHealthy = fallbackHealth.reachable;

    let candidate: ScannerHealthState;
    if (wsHealthy) {
      candidate = this.state === 'HEALTHY' ? 'HEALTHY' : 'RECOVERING';
    } else if (fallbackHealthy) {
      candidate = 'DEGRADED';
    } else {
      candidate = 'UNHEALTHY';
    }

    if (candidate === 'RECOVERING') {
      if (this.state !== 'RECOVERING') {
        this.recoveringSince = Date.now();
        this.reconciliationDone = false;
        void this.deps.fallbackDiscovery.runReconciliation().then((result) => {
          this.lastReconciliation = result;
          this.reconciliationDone = true;
        });
      }
      const ceilingElapsed =
        Date.now() - (this.recoveringSince ?? Date.now()) > this.opts.recoveringCeilingMs;
      if (this.reconciliationDone || ceilingElapsed) {
        candidate = 'HEALTHY';
      }
    }

    // Independent fallback discovery (section 4): only actively scanning
    // while it's actually needed — WS is anything other than fully HEALTHY.
    if (candidate === 'HEALTHY') {
      this.deps.fallbackDiscovery.stopFallbackMode();
    } else {
      this.deps.fallbackDiscovery.startFallbackMode();
    }

    await this.applyState(candidate, { wsHealthy, fallbackHealthy, pumpFunHealth });
  }

  private async applyState(
    next: ScannerHealthState,
    context: {
      wsHealthy: boolean;
      fallbackHealthy: boolean;
      pumpFunHealth: ReturnType<PumpFunMonitor['getHealth']>;
    },
  ): Promise<void> {
    const previous = this.state;
    if (next === previous) {
      if (next === 'HEALTHY') this.lastHealthyAt = Date.now();
      return;
    }

    const outageDurationMs = this.lastHealthyAt ? Date.now() - this.lastHealthyAt : 0;
    this.deps.logger.warn(
      {
        previous,
        next,
        outageDurationMs,
        activeProvider: context.pumpFunHealth.activeProviderLabel,
      },
      `Scanner health transition: ${previous} -> ${next}`,
    );

    if (next === 'UNHEALTHY') {
      await setScannerAutoBuyPauseState(
        this.deps.redis,
        true,
        'all launch-detection sources unhealthy',
      ).catch((err) =>
        this.deps.logger.error({ err }, 'failed to set scanner auto-buy pause flag'),
      );
    } else if (next === 'HEALTHY' && this.opts.autoBuyAutoResumeEnabled) {
      await setScannerAutoBuyPauseState(this.deps.redis, false).catch((err) =>
        this.deps.logger.error({ err }, 'failed to clear scanner auto-buy pause flag'),
      );
    }

    this.state = next;
    this.stateEnteredAt = Date.now();
    if (next === 'HEALTHY') this.lastHealthyAt = Date.now();

    await this.sendTransitionAlert(previous, next, outageDurationMs, context);
  }

  private async sendTransitionAlert(
    previous: ScannerHealthState,
    next: ScannerHealthState,
    outageDurationMs: number,
    context: { pumpFunHealth: ReturnType<PumpFunMonitor['getHealth']> },
  ): Promise<void> {
    const outageMinutes = Math.round(outageDurationMs / 60_000);
    const reconciliation = this.lastReconciliation;
    const reconciliationLine = reconciliation
      ? `Reconciliation: scanned ${reconciliation.signaturesScanned} signatures, found ${reconciliation.candidatesFound} candidate(s), rejected ${reconciliation.duplicatesRejected} duplicate(s).`
      : 'Reconciliation: not yet run for this transition.';

    const message =
      `Scanner health: ${previous} -> ${next}\n` +
      `Failed/active provider: ${context.pumpFunHealth.activeProviderLabel}\n` +
      `Fallback discovery active: ${this.deps.fallbackDiscovery.fallbackModeActive}\n` +
      `Outage duration: ${outageMinutes} min\n` +
      `Reconnect attempts: ${context.pumpFunHealth.reconnectCount}\n` +
      `${reconciliationLine}` +
      (next === 'UNHEALTHY'
        ? '\n\n🚨 NEW auto-buys are now PAUSED. Existing positions, SELL, TP/SL, and trailing-stop continue unaffected. Admin: /resumeautobuy to clear once safe.'
        : '');

    await this.deps.notifier?.notifyError('Pump.fun scanner health', message);
  }
}
