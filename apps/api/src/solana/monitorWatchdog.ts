import type { Logger } from '@nova/shared';

/**
 * Structural shape shared by every onLogs-based launch monitor (PumpFunMonitor,
 * RaydiumCpmmMonitor, OrcaWhirlpoolMonitor, MeteoraDlmmMonitor, PumpSwapMonitor) —
 * exactly the DexMonitor interface, generalized over the monitor's event type.
 */
export interface RestartableMonitor<E> {
  start(onEvent: (event: E) => void | Promise<void>): void;
  stop(): Promise<void> | void;
}

export interface MonitorWatchdogOptions {
  /** Human-readable label for logging (e.g. "pump.fun", "RAYDIUM"). */
  label: string;
  /** If no event has been observed for this long, the underlying subscription is
   * assumed dead and force-restarted (stop + start). */
  idleThresholdMs: number;
  /** How often to check for staleness. Defaults to a quarter of idleThresholdMs
   * (capped at 60s) so the check itself is never the bottleneck. */
  checkIntervalMs?: number;
}

/**
 * Wraps an onLogs-based monitor with a liveness watchdog.
 *
 * `connection.onLogs` websocket subscriptions have no built-in liveness signal:
 * the underlying websocket can silently drop (idle timeout, an RPC provider
 * restart, or a rate limit closing the socket with code 1001 — see
 * resolveAllRpcEndpoints's doc comment in connection.ts for a real production
 * incident of exactly this) without throwing or logging anything. Once that
 * happens, the monitor's callback simply never fires again — detection
 * flatlines with zero visible error, and every downstream consumer (AutoTrader,
 * notifications) silently starves along with it, with `subscriptionId` still
 * set so the monitor's own `start()` guard treats it as already running.
 *
 * This tracks the last time *any* event arrived through the wrapped monitor and
 * force-restarts the subscription (stop, then start again) if none arrived
 * within `idleThresholdMs`. Implements the same start/stop shape as the monitor
 * it wraps, so it's a drop-in replacement at every call site.
 */
export class MonitorWatchdog<E> implements RestartableMonitor<E> {
  private lastEventAt = Date.now();
  private handler: ((event: E) => void | Promise<void>) | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private restarting = false;

  constructor(
    private readonly monitor: RestartableMonitor<E>,
    private readonly logger: Logger,
    private readonly options: MonitorWatchdogOptions,
  ) {}

  start(onEvent: (event: E) => void | Promise<void>): void {
    this.handler = onEvent;
    this.lastEventAt = Date.now();
    this.subscribe();

    const checkIntervalMs =
      this.options.checkIntervalMs ??
      Math.min(60_000, Math.floor(this.options.idleThresholdMs / 4));
    this.timer = setInterval(() => void this.checkAlive(), checkIntervalMs);
  }

  private subscribe(): void {
    this.monitor.start((event) => {
      this.lastEventAt = Date.now();
      return this.handler!(event);
    });
  }

  private async checkAlive(): Promise<void> {
    if (this.restarting || !this.handler) return;
    const idleMs = Date.now() - this.lastEventAt;
    if (idleMs < this.options.idleThresholdMs) return;

    this.restarting = true;
    try {
      this.logger.warn(
        { label: this.options.label, idleMs },
        `MONITOR WATCHDOG: no events for ${idleMs}ms — forcing resubscribe, the underlying websocket likely dropped silently`,
      );
      try {
        await this.monitor.stop();
      } catch (err) {
        this.logger.warn(
          { label: this.options.label, err },
          'MONITOR WATCHDOG: stop() before restart failed — restarting anyway',
        );
      }
      this.lastEventAt = Date.now();
      this.subscribe();
    } finally {
      this.restarting = false;
    }
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    await this.monitor.stop();
  }
}
