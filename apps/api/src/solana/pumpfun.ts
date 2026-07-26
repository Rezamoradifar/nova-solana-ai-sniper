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

/** One WebSocket-capable RPC provider this monitor can subscribe against. */
export interface PumpFunWsProvider {
  label: string;
  connection: Connection;
}

export interface PumpFunMonitorOptions {
  /**
   * Legacy blind periodic resubscribe (same provider), preserved for explicit
   * opt-in/backward compat — see the class doc comment on why this alone was
   * never a full fix. 0/unset disables it (default).
   */
  resubscribeIntervalMs?: number;
  /** How often the internal watchdog re-checks liveness. */
  watchdogCheckIntervalMs?: number;
  /**
   * No valid Create event within this long (despite raw traffic — see
   * `isCreateInstruction`) is the confirmed "silently dropping Creates"
   * pattern this class exists to catch. Same threshold
   * PUMPFUN_LAUNCH_SILENCE_ALERT_MS already used for the pre-existing alert.
   */
  launchSilenceThresholdMs?: number;
  /**
   * After a same-provider resubscribe attempt, how long to wait for a fresh
   * raw event before concluding it didn't help and escalating to
   * failoverToNextProvider instead of repeating the same fix indefinitely.
   */
  watchdogVerifyWindowMs?: number;
  /** Bounded exponential backoff (jittered) applied to a provider that just
   * failed a subscribe/verify. */
  providerCooldownBaseMs?: number;
  providerCooldownMaxMs?: number;
  /** How often, while not on the primary (first) provider, to try switching
   * back and verify it has recovered. */
  primaryRecoveryProbeIntervalMs?: number;
}

export interface PumpFunHealthSnapshot {
  activeProviderLabel: string;
  activeProviderIndex: number;
  providerCount: number;
  lastRawEventAt: number | undefined;
  lastValidCreateAt: number | undefined;
  lastSubscribedAt: number | undefined;
  reconnectCount: number;
  consecutiveFailures: number;
  /** True once a valid Create (or, absent one yet, raw traffic) has been seen
   * recently enough on the CURRENT provider — the one signal
   * scannerHealth.ts needs to decide HEALTHY vs. DEGRADED/UNHEALTHY. */
  activeProviderHealthy: boolean;
  allProvidersOnCooldown: boolean;
}

interface ProviderRuntimeState {
  failureCount: number;
  cooldownUntil: number;
}

/** ±20% jitter, same convention as resilientConnection.ts, so many callers
 * backing off at once don't retry in lockstep. */
function withJitter(ms: number): number {
  return Math.round(ms * (0.8 + Math.random() * 0.4));
}

const DEFAULT_WATCHDOG_CHECK_INTERVAL_MS = 60_000;
const DEFAULT_LAUNCH_SILENCE_THRESHOLD_MS = 25 * 60 * 1000;
const DEFAULT_WATCHDOG_VERIFY_WINDOW_MS = 30_000;
const DEFAULT_PROVIDER_COOLDOWN_BASE_MS = 30_000;
const DEFAULT_PROVIDER_COOLDOWN_MAX_MS = 5 * 60 * 1000;
const DEFAULT_PRIMARY_RECOVERY_PROBE_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Subscribes to pump.fun program logs over the RPC websocket. This is a
 * lightweight signal ("something happened involving this program") — the
 * detection layer parses `logs` for the `create`/`buy` instruction discriminants
 * to decide whether it's a new token launch, a buy, or a migration.
 *
 * 2026-07-19 production investigation: Solana's `logsSubscribe`/`onLogs` pubsub
 * is explicitly best-effort, not guaranteed delivery — a provider can silently
 * drop individual notifications under load with no client-visible error. Live
 * evidence: raw-traffic liveness (every log delivery, not just qualifying
 * creates) never went silent despite 20-190+ minute gaps in genuine new-token
 * detection recurring in production, meaning the subscription itself kept
 * receiving *some* traffic (buys/sells) throughout — it wasn't dead, it was
 * dropping specific notifications.
 *
 * 2026-07-23 recurring-incident follow-up: a blind/reactive same-provider
 * resubscribe (this class's sole mitigation until now) kept recurring because
 * it has no escalation path — if the provider's own server-side subscription
 * handling is what's dropping events, re-subscribing to that SAME provider can
 * easily reproduce the same failure. This class now accepts an ORDERED LIST of
 * WS-capable providers and will fail over to the next one (bounded exponential
 * backoff + jitter per provider, never overlapping reconnects) when a
 * same-provider resubscribe doesn't measurably help within
 * `watchdogVerifyWindowMs`, or immediately on a harder signal (raw traffic
 * itself goes silent, or `onLogs` throws synchronously). It also periodically
 * tries switching back to the primary (first-listed) provider once its
 * cooldown has expired, so a recovered primary is used again rather than
 * staying on a fallback forever.
 *
 * Classification (is a given raw event a genuine Create?) intentionally still
 * lives in the caller (see detectors.ts/worker.ts) — this class only tracks
 * liveness. Callers MUST call `recordValidCreate()` whenever they confirm a
 * raw event was a real Create, mirroring how they already call
 * `recordRawEvent()`-equivalent liveness tracking for other sources; without
 * that call the watchdog can never observe recovery and will keep escalating.
 */
export class PumpFunMonitor {
  private subscriptionId: number | undefined;
  private resubscribeTimer: ReturnType<typeof setInterval> | undefined;
  private watchdogTimer: ReturnType<typeof setInterval> | undefined;
  private primaryRecoveryTimer: ReturnType<typeof setInterval> | undefined;
  private verificationTimer: ReturnType<typeof setTimeout> | undefined;
  private onEvent: PumpFunEventHandler | undefined;
  private opts: Required<PumpFunMonitorOptions> = {
    resubscribeIntervalMs: 0,
    watchdogCheckIntervalMs: DEFAULT_WATCHDOG_CHECK_INTERVAL_MS,
    launchSilenceThresholdMs: DEFAULT_LAUNCH_SILENCE_THRESHOLD_MS,
    watchdogVerifyWindowMs: DEFAULT_WATCHDOG_VERIFY_WINDOW_MS,
    providerCooldownBaseMs: DEFAULT_PROVIDER_COOLDOWN_BASE_MS,
    providerCooldownMaxMs: DEFAULT_PROVIDER_COOLDOWN_MAX_MS,
    primaryRecoveryProbeIntervalMs: DEFAULT_PRIMARY_RECOVERY_PROBE_INTERVAL_MS,
  };

  private activeProviderIndex = 0;
  private readonly providerState: ProviderRuntimeState[];
  /** Guards against overlapping reconnect attempts (periodic timer, reactive
   * watchdog, and the primary-recovery probe can all fire independently) —
   * whichever one is already in flight wins; the others no-op rather than
   * race it, since the next tick will observe the resulting state anyway. */
  private switching = false;

  private lastRawEventAt: number | undefined;
  private lastValidCreateAt: number | undefined;
  private lastSubscribedAt: number | undefined;
  private reconnectCount = 0;
  private consecutiveFailures = 0;

  constructor(
    private readonly providers: readonly PumpFunWsProvider[],
    private readonly logger: Logger,
  ) {
    if (providers.length === 0) {
      throw new Error('PumpFunMonitor requires at least one WS-capable provider');
    }
    this.providerState = providers.map(() => ({ failureCount: 0, cooldownUntil: 0 }));
  }

  private get activeProvider(): PumpFunWsProvider {
    return this.providers[this.activeProviderIndex]!;
  }

  start(onEvent: PumpFunEventHandler, options?: PumpFunMonitorOptions): void {
    if (this.subscriptionId !== undefined) return;
    this.opts = { ...this.opts, ...options };
    this.onEvent = onEvent;
    this.subscribe();

    if (this.opts.resubscribeIntervalMs) {
      this.resubscribeTimer = setInterval(
        () => void this.changeProvider('periodic', this.activeProviderIndex, false),
        this.opts.resubscribeIntervalMs,
      );
      this.resubscribeTimer.unref?.();
    }

    this.watchdogTimer = setInterval(
      () => void this.checkWatchdog(),
      this.opts.watchdogCheckIntervalMs,
    );
    this.watchdogTimer.unref?.();

    if (this.providers.length > 1) {
      this.primaryRecoveryTimer = setInterval(
        () => void this.checkPrimaryRecovery(),
        this.opts.primaryRecoveryProbeIntervalMs,
      );
      this.primaryRecoveryTimer.unref?.();
    }
  }

  private subscribe(): void {
    const provider = this.activeProvider;
    try {
      this.subscriptionId = provider.connection.onLogs(
        PUMPFUN_PROGRAM_ID,
        (logInfo, ctx) => {
          if (logInfo.err) return;
          this.recordRawEvent();
          void this.onEvent?.({
            signature: logInfo.signature,
            slot: ctx.slot,
            logs: logInfo.logs,
            detectedAt: new Date().toISOString(),
          });
        },
        'processed',
      );
      this.lastSubscribedAt = Date.now();
      this.logger.info(
        { programId: PUMPFUN_PROGRAM_ID.toBase58(), provider: provider.label },
        'pump.fun monitor started',
      );
    } catch (err) {
      this.logger.error(
        { err, provider: provider.label },
        'pump.fun monitor: subscribe threw — failing over immediately',
      );
      this.subscriptionId = undefined;
      this.failAndCooldown(this.activeProviderIndex);
      void this.failoverToNextProvider('subscribe_failed');
    }
  }

  /** Every raw log delivery (regardless of classification) — the liveness
   * signal a genuinely dead subscription can never produce. */
  private recordRawEvent(): void {
    this.lastRawEventAt = Date.now();
  }

  /** Callers must invoke this once they've classified a raw event as a
   * genuine Create — see class doc comment. */
  recordValidCreate(): void {
    this.lastValidCreateAt = Date.now();
    this.consecutiveFailures = 0;
    this.pendingCreateSilenceEscalation = false;
  }

  private silenceReferenceMs(lastAt: number | undefined): number {
    const reference = lastAt ?? this.lastSubscribedAt ?? Date.now();
    return Date.now() - reference;
  }

  private failAndCooldown(providerIndex: number): void {
    const st = this.providerState[providerIndex]!;
    st.failureCount += 1;
    const backoff = Math.min(
      this.opts.providerCooldownMaxMs,
      this.opts.providerCooldownBaseMs * 2 ** (st.failureCount - 1),
    );
    st.cooldownUntil = Date.now() + withJitter(backoff);
  }

  private clearCooldown(providerIndex: number): void {
    const st = this.providerState[providerIndex]!;
    st.failureCount = 0;
    st.cooldownUntil = 0;
  }

  /** Next provider whose cooldown has expired, round-robin from the current
   * one; falls back to the least-recently-failed provider if every single one
   * is currently on cooldown, so we always keep trying rather than giving up
   * entirely. */
  private nextProviderIndex(from: number): number {
    const now = Date.now();
    for (let offset = 1; offset <= this.providers.length; offset++) {
      const idx = (from + offset) % this.providers.length;
      if (this.providerState[idx]!.cooldownUntil <= now) return idx;
    }
    let best = 0;
    for (let i = 1; i < this.providers.length; i++) {
      if (this.providerState[i]!.cooldownUntil < this.providerState[best]!.cooldownUntil) best = i;
    }
    return best;
  }

  /**
   * Tears down the current subscription (best-effort — a failed removal
   * never blocks resubscribing, same as the pre-2026-07-23 behavior) and
   * subscribes on `targetProviderIndex`. `reason` is purely for logging/
   * metrics; callers decide the target.
   */
  private async changeProvider(
    reason:
      | 'periodic'
      | 'watchdog_same_provider'
      | 'watchdog_escalation'
      | 'raw_silence'
      | 'subscribe_failed'
      | 'verify_failed'
      | 'primary_recovery_probe'
      | 'manual',
    targetProviderIndex: number,
    verifyAfter: boolean,
  ): Promise<void> {
    if (this.switching) {
      this.logger.debug({ reason }, 'pump.fun monitor: reconnect already in flight — skipping');
      return;
    }
    this.switching = true;
    try {
      const oldId = this.subscriptionId;
      const oldProvider = this.activeProvider;
      this.subscriptionId = undefined;
      if (oldId !== undefined) {
        try {
          await oldProvider.connection.removeOnLogsListener(oldId);
        } catch (err) {
          this.logger.warn(
            { err, reason },
            'pump.fun monitor: failed to remove old subscription during reconnect — continuing anyway',
          );
        }
      }

      this.activeProviderIndex = targetProviderIndex;
      this.reconnectCount += 1;
      this.subscribe();
      this.logger.info(
        { reason, provider: this.activeProvider.label },
        'pump.fun monitor: reconnect complete',
      );

      if (verifyAfter) {
        this.scheduleVerification(this.activeProviderIndex, Date.now(), reason);
      }
    } finally {
      this.switching = false;
    }
  }

  private async failoverToNextProvider(
    reason: 'watchdog_escalation' | 'subscribe_failed' | 'raw_silence' | 'verify_failed',
  ): Promise<void> {
    const target = this.nextProviderIndex(this.activeProviderIndex);
    await this.changeProvider(reason, target, true);
  }

  /**
   * Confirms a REAL provider/subscription change (a genuinely different
   * socket, not just re-registering on the one we're already suspicious of)
   * actually restored basic connectivity — a fresh raw event arriving after
   * `subscribedAt` is proof of that. Deliberately NOT used to "verify" a
   * same-provider resubscribe: raw traffic being present is nearly guaranteed
   * on a live, high-traffic program even when the SAME provider is still
   * selectively dropping Creates, so that would almost always report a false
   * "fixed" — see checkWatchdog's own escalation logic for how the
   * create-silence case is actually confirmed instead.
   */
  private scheduleVerification(
    providerIndexAtSchedule: number,
    subscribedAt: number,
    reason: string,
  ): void {
    if (this.verificationTimer) clearTimeout(this.verificationTimer);
    this.verificationTimer = setTimeout(() => {
      // Something else already moved us on (or off) — this stale check no
      // longer applies, let whichever reconnect is current own verification.
      if (this.activeProviderIndex !== providerIndexAtSchedule || this.switching) return;

      const verified = (this.lastRawEventAt ?? 0) > subscribedAt;
      if (verified) {
        this.clearCooldown(providerIndexAtSchedule);
        this.logger.info(
          { provider: this.activeProvider.label, reason },
          'pump.fun monitor: reconnect verified healthy — receiving raw events again',
        );
        return;
      }

      this.consecutiveFailures += 1;
      this.failAndCooldown(providerIndexAtSchedule);
      this.logger.warn(
        { provider: this.activeProvider.label, reason },
        'pump.fun monitor: reconnect did NOT restore raw traffic within the verify window — failing over again',
      );
      void this.failoverToNextProvider('verify_failed');
    }, this.opts.watchdogVerifyWindowMs);
    this.verificationTimer.unref?.();
  }

  /**
   * `checkWatchdog` runs on every tick; `pendingCreateSilenceEscalation`
   * tracks whether the LAST tick already gave the current provider a
   * same-provider resubscribe chance for its create-silence — if creates are
   * STILL silent on the very next check, that resubscribe demonstrably didn't
   * fix anything (2026-07-23: this is the exact gap the pre-existing
   * blind/reactive same-provider-only resubscribe had — it never escalated,
   * so a provider that keeps selectively dropping Creates kept getting the
   * same ineffective fix indefinitely). Reset whenever a valid Create is
   * actually recorded, or a provider change happens for any other reason.
   */
  private pendingCreateSilenceEscalation = false;

  private async checkWatchdog(): Promise<void> {
    const rawSilentMs = this.silenceReferenceMs(this.lastRawEventAt);
    const createSilentMs = this.silenceReferenceMs(this.lastValidCreateAt);

    // Raw traffic itself has gone quiet — the underlying socket/provider is
    // most likely genuinely down, not selectively dropping Creates. Escalate
    // straight to provider failover rather than retrying the same one.
    if (rawSilentMs > this.opts.launchSilenceThresholdMs) {
      this.pendingCreateSilenceEscalation = false;
      this.consecutiveFailures += 1;
      this.failAndCooldown(this.activeProviderIndex);
      this.logger.warn(
        { provider: this.activeProvider.label, rawSilentMs },
        'pump.fun monitor: raw traffic silent past threshold — assuming a dead subscription, failing over',
      );
      await this.failoverToNextProvider('raw_silence');
      return;
    }

    // Raw traffic is fine, but no genuine Create has been confirmed in a long
    // time — the exact "silently dropping Create notifications" pattern this
    // class exists to catch.
    if (createSilentMs > this.opts.launchSilenceThresholdMs) {
      if (this.pendingCreateSilenceEscalation) {
        // Already gave this provider one same-provider resubscribe chance
        // (see below) and creates are STILL silent a full threshold window
        // later — that fix didn't work. Escalate to a real provider failover
        // instead of repeating it forever.
        this.pendingCreateSilenceEscalation = false;
        this.consecutiveFailures += 1;
        this.failAndCooldown(this.activeProviderIndex);
        this.logger.warn(
          { provider: this.activeProvider.label, createSilentMs },
          'pump.fun monitor: create silence persisted past a same-provider resubscribe — failing over to a different provider',
        );
        await this.failoverToNextProvider('watchdog_escalation');
        return;
      }

      this.logger.warn(
        { provider: this.activeProvider.label, createSilentMs },
        'pump.fun monitor: no valid Create despite healthy raw traffic — resubscribing to the same provider once before failing over',
      );
      this.pendingCreateSilenceEscalation = true;
      await this.changeProvider('watchdog_same_provider', this.activeProviderIndex, false);
    }
  }

  private async checkPrimaryRecovery(): Promise<void> {
    if (this.activeProviderIndex === 0) return;
    if (this.providerState[0]!.cooldownUntil > Date.now()) return;
    this.logger.info('pump.fun monitor: probing whether the primary provider has recovered');
    await this.changeProvider('primary_recovery_probe', 0, true);
  }

  /** Manual/test/admin trigger — same same-provider-resubscribe path the
   * internal watchdog's first attempt uses, exposed for on-demand use. */
  async forceResubscribe(): Promise<void> {
    if (this.subscriptionId === undefined && !this.lastSubscribedAt) return;
    await this.changeProvider('manual', this.activeProviderIndex, false);
  }

  getHealth(): PumpFunHealthSnapshot {
    const now = Date.now();
    const rawSilentMs = this.silenceReferenceMs(this.lastRawEventAt);
    const createSilentMs = this.silenceReferenceMs(this.lastValidCreateAt);
    const activeProviderHealthy =
      this.subscriptionId !== undefined &&
      !this.switching &&
      rawSilentMs <= this.opts.launchSilenceThresholdMs &&
      createSilentMs <= this.opts.launchSilenceThresholdMs;
    const allProvidersOnCooldown = this.providerState.every((s) => s.cooldownUntil > now);

    return {
      activeProviderLabel: this.activeProvider.label,
      activeProviderIndex: this.activeProviderIndex,
      providerCount: this.providers.length,
      lastRawEventAt: this.lastRawEventAt,
      lastValidCreateAt: this.lastValidCreateAt,
      lastSubscribedAt: this.lastSubscribedAt,
      reconnectCount: this.reconnectCount,
      consecutiveFailures: this.consecutiveFailures,
      activeProviderHealthy,
      allProvidersOnCooldown,
    };
  }

  async stop(): Promise<void> {
    if (this.resubscribeTimer) clearInterval(this.resubscribeTimer);
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    if (this.primaryRecoveryTimer) clearInterval(this.primaryRecoveryTimer);
    if (this.verificationTimer) clearTimeout(this.verificationTimer);
    this.resubscribeTimer = undefined;
    this.watchdogTimer = undefined;
    this.primaryRecoveryTimer = undefined;
    this.verificationTimer = undefined;
    if (this.subscriptionId === undefined) return;
    const id = this.subscriptionId;
    this.subscriptionId = undefined;
    await this.activeProvider.connection.removeOnLogsListener(id);
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
