import { Connection, PublicKey } from '@solana/web3.js';
import type { Logger } from '@nova/shared';

export const PUMPFUN_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');

export interface PumpFunLaunchEvent {
  signature: string;
  slot: number;
  logs: string[];
  detectedAt: string;
}

export type PumpFunEventHandler = (event: PumpFunLaunchEvent) => void | Promise<void>;

/**
 * Subscribes to pump.fun program logs over the RPC websocket. This is a
 * lightweight signal ("something happened involving this program") — the
 * detection layer parses `logs` for the `create`/`buy` instruction discriminants
 * to decide whether it's a new token launch, a buy, or a migration.
 *
 * 2026-07-19 production investigation: Solana's `logsSubscribe`/`onLogs` pubsub
 * is explicitly best-effort, not guaranteed delivery — a provider can silently
 * drop individual notifications under load with no client-visible error. Live
 * evidence: SourceHealthMonitor's raw-traffic liveness check (fed by every log
 * delivery, not just qualifying creates) never fired despite 20-190 minute gaps
 * in genuine new-token detection, meaning the subscription itself kept
 * receiving *some* traffic (buys/sells) throughout — it wasn't dead, it was
 * dropping specific notifications. A polling reconciliation backstop (the
 * MigrationMonitor pattern) turned out not to be affordable here: the program
 * does ~2,300 signatures/min total, and Solana's RPC API offers no way to
 * bulk-filter by instruction type — every signature would need its own
 * getTransaction call just to check if it's a Create. `resubscribeIntervalMs`
 * is a cheap (zero RPC cost) mitigation attempt instead: periodically drop and
 * re-add the subscription even without confirmed silence, on the theory that a
 * long-lived subscription is more likely to accumulate whatever server-side
 * state causes the drops. Not confirmed to fix it — see the companion
 * launch-specific health alert in worker.ts for evidence of whether it helps.
 */
export class PumpFunMonitor {
  private subscriptionId: number | undefined;
  private resubscribeTimer: ReturnType<typeof setInterval> | undefined;
  private onEvent: PumpFunEventHandler | undefined;

  constructor(
    private readonly connection: Connection,
    private readonly logger: Logger,
  ) {}

  /**
   * `resubscribeIntervalMs`, if given, periodically tears down and re-creates
   * the subscription — see class doc comment. Optional so every existing
   * caller (and every test) that omits it keeps today's exact behavior: one
   * subscription for the process's lifetime.
   */
  start(onEvent: PumpFunEventHandler, resubscribeIntervalMs?: number): void {
    if (this.subscriptionId !== undefined) return;
    this.onEvent = onEvent;
    this.subscribe();
    if (resubscribeIntervalMs) {
      this.resubscribeTimer = setInterval(
        () => void this.resubscribe('periodic'),
        resubscribeIntervalMs,
      );
      this.resubscribeTimer.unref?.();
    }
  }

  private subscribe(): void {
    this.subscriptionId = this.connection.onLogs(
      PUMPFUN_PROGRAM_ID,
      (logInfo, ctx) => {
        if (logInfo.err) return;
        void this.onEvent?.({
          signature: logInfo.signature,
          slot: ctx.slot,
          logs: logInfo.logs,
          detectedAt: new Date().toISOString(),
        });
      },
      'processed',
    );
    this.logger.info({ programId: PUMPFUN_PROGRAM_ID.toBase58() }, 'pump.fun monitor started');
  }

  /**
   * Old subscription id is cleared before the removal call resolves (not
   * after) so a resubscribe failure can't leave subscriptionId pointing at an
   * id we already asked the server to drop — worst case is a brief gap with
   * zero subscriptions rather than a confusing half-torn-down state. Node's
   * single-threaded event loop means this synchronous prefix (read oldId,
   * clear the field) always runs to completion before any other call to this
   * method can start, so a call from the blind periodic timer racing a call
   * from the reactive watchdog below can never both act on the same
   * subscription id — the second one always sees the field already cleared
   * and just re-subscribes fresh, never double-subscribes.
   */
  private async resubscribe(reason: 'periodic' | 'watchdog'): Promise<void> {
    if (this.subscriptionId === undefined) return;
    const oldId = this.subscriptionId;
    this.subscriptionId = undefined;
    try {
      await this.connection.removeOnLogsListener(oldId);
    } catch (err) {
      this.logger.warn(
        { err, reason },
        'pump.fun monitor: failed to remove old subscription during resubscribe — continuing to resubscribe anyway',
      );
    }
    this.subscribe();
    this.logger.info({ reason }, 'pump.fun monitor: resubscribe complete');
  }

  /**
   * Production incident (2026-07-22): the launch-silence health alert
   * (worker.ts's launchHealthMonitor — raw traffic healthy, but zero
   * qualifying Create events for PUMPFUN_LAUNCH_SILENCE_ALERT_MS) previously
   * only ever sent a Telegram notification; nothing actually acted on it, so
   * a genuinely silently-dropping subscription stayed dropped until the next
   * blind periodic resubscribe (up to PUMPFUN_RESUBSCRIBE_INTERVAL_MS later,
   * or never, if that's unset) or a manual restart. This lets that confirmed
   * alert — not a guess, not a raw traffic hiccup — force an immediate
   * resubscribe. Reuses the exact same teardown/recreate path as the blind
   * timer, so "no duplicate listeners" holds here too.
   */
  async forceResubscribe(): Promise<void> {
    await this.resubscribe('watchdog');
  }

  async stop(): Promise<void> {
    if (this.resubscribeTimer) clearInterval(this.resubscribeTimer);
    this.resubscribeTimer = undefined;
    if (this.subscriptionId === undefined) return;
    await this.connection.removeOnLogsListener(this.subscriptionId);
    this.subscriptionId = undefined;
  }
}

// Anchored to the exact instruction name (not a bare substring): live sampling this
// session turned up `CreateFeeSharingConfig` and `MigrateBondingCurveCreator` — unrelated
// fee/creator-payout admin instructions that happen to contain "Create"/"Migrate" as a
// substring and involve zero token balance movement. A loose `.includes()` match would
// misclassify those as a new-token launch / migration. `CreateV2` is included alongside
// `Create` since pump.fun's live instruction set includes both create variants.
const CREATE_INSTRUCTION_RE = /Instruction:\s*(Create|CreateV2)$/;
const BUY_INSTRUCTION_RE = /Instruction:\s*(Buy|BuyV2|BuyExactQuoteInV2)$/;
const WITHDRAW_INSTRUCTION_RE = /Instruction:\s*Withdraw$/;

export function isCreateInstruction(logs: string[]): boolean {
  return logs.some((l) => CREATE_INSTRUCTION_RE.test(l));
}

export function isBuyInstruction(logs: string[]): boolean {
  return logs.some((l) => BUY_INSTRUCTION_RE.test(l));
}

/**
 * Best-effort hint only, not authoritative — live sampling found no reliably-observed
 * single "this bonding curve just migrated" log line (the real Withdraw-driven migration
 * event turned out to be rare relative to overall program traffic, and "Migrate" as a
 * substring false-positives on unrelated admin instructions, see above). The ground-truth
 * migration signal is the bonding curve account's own `complete` flag
 * (`solana/pumpfunBondingCurve.ts`), checked by `MigrationMonitor`. This hint exists only
 * to trigger an immediate out-of-band recheck instead of waiting for the next poll tick.
 */
export function isMigrationInstruction(logs: string[]): boolean {
  return logs.some((l) => WITHDRAW_INSTRUCTION_RE.test(l));
}
