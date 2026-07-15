import type { Logger } from '@nova/shared';

export interface SourceHealthAlert {
  source: string;
  silentForMs: number;
}

export type SourceHealthAlertHandler = (alert: SourceHealthAlert) => void | Promise<void>;

/**
 * Tracks last-seen-activity per discovery source and fires `onAlert` once when a
 * source goes silent past `thresholdMs`, then again if it recovers and goes
 * silent a second time (never repeats while already alerted, so a stuck source
 * pages once, not every check tick).
 *
 * Liveness must be fed from *raw* program traffic (see worker.ts's wiring —
 * pump.fun's own onEvent already fires on every log; PumpSwap/Raydium/Orca/
 * Meteora get a dedicated raw onLogs heartbeat separate from DexRegistry's
 * pool-creation-filtered monitors), not from qualifying "new token" discovery
 * counts. Orca/Raydium/Meteora routinely go 1-20+ hours between real launches
 * even when fully healthy (see the 2026-07-14 production audit), so a
 * discovery-count gate would false-alarm on every quiet-but-working source; a
 * live program still emits swap/other traffic constantly (~100+ events/sec
 * observed live for Meteora), so raw traffic is a tight, low-false-positive
 * liveness signal that still catches a genuinely dead subscription well within
 * one threshold window.
 */
export class SourceHealthMonitor {
  private readonly lastSeenAt = new Map<string, number>();
  private readonly alerted = new Set<string>();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    sources: readonly string[],
    private readonly thresholdMs: number,
    private readonly logger: Logger,
    private readonly onAlert?: SourceHealthAlertHandler,
  ) {
    const now = Date.now();
    for (const source of sources) this.lastSeenAt.set(source, now);
  }

  /** Call on every raw activity event for a source — see class doc comment on what counts. */
  recordActivity(source: string): void {
    this.lastSeenAt.set(source, Date.now());
    if (this.alerted.delete(source)) {
      this.logger.info({ source }, 'Discovery source health: recovered');
    }
  }

  start(checkIntervalMs = 60_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.check(), checkIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async check(): Promise<void> {
    const now = Date.now();
    for (const [source, lastSeen] of this.lastSeenAt) {
      const silentForMs = now - lastSeen;
      if (silentForMs > this.thresholdMs && !this.alerted.has(source)) {
        this.alerted.add(source);
        this.logger.error(
          { source, silentForMs },
          'Discovery source health: SILENT — no raw activity past threshold',
        );
        await this.onAlert?.({ source, silentForMs });
      }
    }
  }
}
