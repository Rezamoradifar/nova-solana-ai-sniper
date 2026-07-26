import type { PrismaClient, Token, PositionMonitoringState } from '@prisma/client';
import type { Connection } from '@solana/web3.js';
import type { Logger } from '@nova/shared';
import type { NotificationService } from '@nova/telegram-bot';
import type { DexScreenerClient } from '../solana/dexscreener.js';
import type { JupiterClient } from '../solana/jupiter.js';
import { SOL_MINT } from '../solana/jupiter.js';
import type { DexRegistry } from '../solana/dex/registry.js';
import { sharedSolPriceOracle } from '../solana/pumpfunBondingCurve.js';
import type { PositionManager } from './positionManager.js';
import { getRealTokenBalance } from './positionManager.js';
import { TtlCache } from '../lib/ttlCache.js';
import { isTransientQuoteError } from './sellabilityCheck.js';
import {
  isPlausiblePriceUpdate,
  reconcilePriceOutlier,
  evaluateHardLossCeiling,
  OUTLIER_RECONCILE_AFTER_CONSECUTIVE_REJECTIONS,
  OUTLIER_FORCE_ACCEPT_AFTER_MS,
  DEFAULT_MAX_LOSS_PERCENT,
  type PriceReconciliationResult,
} from './exitEngine.js';

export interface PriceMonitorDeps {
  prisma: PrismaClient;
  dexScreener: DexScreenerClient;
  positionManager: PositionManager;
  logger: Logger;
  encryptionKey: string;
  /**
   * Root-cause fix (2026-07-18): both used only to reconcile a price tick
   * that already failed isPlausiblePriceUpdate, against a second, independent
   * source, before it can starve a position of updates indefinitely — see
   * exitEngine.ts's reconcilePriceOutlier doc comment. Optional so any
   * existing test construction of PriceMonitorDeps without these keeps
   * working unchanged; reconciliation is simply skipped (falls straight
   * through to the force-accept-after-ceiling path) if either is omitted.
   */
  jupiter?: JupiterClient;
  dexRegistry?: DexRegistry;
  /**
   * 2026-07-21 audit fix: needed for the proactive zero-balance reconciliation
   * check (E1) below — reads the wallet's PUBLIC key balance only, no secret
   * ever touched here. Optional so existing test construction keeps working;
   * the reconciliation check is simply skipped if omitted.
   */
  connection?: Connection;
  /** Telegram alerting for stale-price/outlier-reconciliation events — see F.
   * Optional, same convention as positionManager's own notifier field. */
  notifier?: NotificationService;
  /**
   * 2026-07-22 audit (repeated stale-price alert spam): how long after the
   * last missing-price/no-sell-route alert a still-unresolved position gets
   * reminded again — the persisted-state fix below (see
   * Position.monitoringState in schema.prisma) already stops the *every-tick*
   * spam this fixes; this is the separate, much longer "still broken, don't
   * let it go silent forever either" cadence. Defaults to
   * DEFAULT_STALE_REMINDER_INTERVAL_MS so every existing test/caller that
   * omits it is unaffected.
   */
  staleReminderIntervalMs?: number;
  /** How long a position may sit in the confirmed NO_SELL_ROUTE state before
   * being escalated to MANUAL_REVIEW — a diagnostic flag only, never an
   * automatic close. Defaults to DEFAULT_MANUAL_REVIEW_AFTER_MS. */
  manualReviewAfterMs?: number;
}

/** 2026-07-21 audit (section E2): once a position has gone this long with zero
 * usable price data (DexScreener empty AND no Jupiter fallback), alert once —
 * reuses the same 10-minute horizon as the outlier force-accept ceiling, since
 * both represent "this has gone on long enough that a human should know." */
export const STALE_PRICE_ALERT_AFTER_MS = OUTLIER_FORCE_ACCEPT_AFTER_MS;

/** One alert per position per stale *outlier-rejection* episode (see
 * handleOutlierRejection below) — the missing-price/no-sell-route alert this
 * file also sends no longer uses this cache at all (2026-07-22 audit: it was
 * in-memory only, which is exactly why a process restart reset the "how long
 * has this been going on" clock back to zero — see Position.monitoringState
 * in schema.prisma, which replaces it for that alert specifically). */
const STALE_PRICE_ALERT_DEDUPE_TTL_MS = 60 * 60 * 1000;

const DEFAULT_STALE_REMINDER_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MANUAL_REVIEW_AFTER_MS = 24 * 60 * 60 * 1000;

interface MonitoringStateFields {
  id: string;
  monitoringState: PositionMonitoringState;
  monitoringStateSince: Date | null;
  lastMonitoringAlertAt: Date | null;
  lastAlertedMonitoringState: PositionMonitoringState | null;
  token: Token;
}

/**
 * Polls every OPEN position's current price and hands it to
 * PositionManager.checkAndMaybeClose, which decides (via the pure evaluateExit
 * logic) whether take-profit/stop-loss/trailing-stop should fire. This is the
 * piece that makes those fields actually do something — without a loop
 * driving it, they're just stored numbers nothing ever reads.
 */
export class PriceMonitor {
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;
  // Root-cause fix (2026-07-18): per-position consecutive-outlier-rejection
  // streak, in-memory for the process lifetime — same lifetime assumption
  // PositionManager's unverifiedSwapLocks/openLocks already rely on. Cleared
  // on any accepted (plausible or reconciled) tick for that position.
  private readonly outlierState = new Map<string, { count: number; firstRejectedAt: number }>();
  // 2026-07-21 audit (E2): per-position consecutive "DexScreener returned no
  // price at all" streak — distinct from outlierState, which only tracks
  // ticks that got a price but rejected it as implausible. A position stuck
  // here never even reaches the plausibility check. Cosmetic/log-only counter
  // now (2026-07-22 audit) — losing it on a restart just means the log line
  // undercounts consecutive misses for one tick; it no longer drives any
  // alert/elapsed-time decision, so it doesn't need to be persisted.
  private readonly noPriceState = new Map<string, { count: number }>();
  private readonly stalePriceAlerted = new TtlCache<string>(STALE_PRICE_ALERT_DEDUPE_TTL_MS);
  private readonly staleReminderIntervalMs: number;
  private readonly manualReviewAfterMs: number;

  constructor(private readonly deps: PriceMonitorDeps) {
    this.staleReminderIntervalMs =
      deps.staleReminderIntervalMs ?? DEFAULT_STALE_REMINDER_INTERVAL_MS;
    this.manualReviewAfterMs = deps.manualReviewAfterMs ?? DEFAULT_MANUAL_REVIEW_AFTER_MS;
  }

  start(intervalMs: number): void {
    this.timer = setInterval(() => void this.tick(), intervalMs);
  }

  stop(): void {
    clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    // A slow RPC/API round-trip on one tick should never overlap with the next timer fire.
    if (this.ticking) return;
    this.ticking = true;
    try {
      // NO_SELL_ROUTE fix (2026-07-26, Phase 6): a position marked
      // sellUnsellable is archived from active monitoring — PositionManager
      // has already given up on it after maxPermanentRouteRetries consecutive
      // no-route failures and a human alert has already gone out (see
      // PositionManager.recordPermanentSellFailure). Before this exclusion,
      // such a position still cost a full tick's worth of work forever (a
      // wallet-balance RPC read, a DexScreener price fetch, a liquidity probe,
      // evaluateExit) even though the one thing that work could lead to — an
      // actual sell attempt — was already unconditionally skipped deeper in
      // checkAndMaybeClose. status stays OPEN (it still holds real tokens and
      // must keep counting toward portfolio value / per-wallet position
      // limits — see safety.ts), only the monitoring loop stops touching it.
      const openPositions = await this.deps.prisma.position.findMany({
        where: { status: 'OPEN', sellUnsellable: false },
        include: { token: true, wallet: true },
      });

      // Monitoring-responsiveness fix (2026-07-23, USOH incident follow-up):
      // this used to be a sequential for-loop with an `await` per position —
      // one position stuck retrying a failed SELL (confirmTransaction waiting
      // out a near-full blockhash-validity window, tens of seconds) blocked
      // price/stop-loss evaluation for every OTHER open position until it
      // finished. Live-verified 2026-07-23: two stuck USOH positions were
      // enough to starve the rest of the tick. Positions are fully
      // independent (different wallets/tokens/locks, all already keyed by
      // position/wallet id — see PositionManager's openLocks/
      // unverifiedSwapLocks) so processing them concurrently is safe; only
      // the per-tick DB read above and the `this.ticking` re-entrancy guard
      // need to stay tick-level.
      await Promise.allSettled(openPositions.map((position) => this.processPosition(position)));
    } finally {
      this.ticking = false;
    }
  }

  private async processPosition(
    position: MonitoringStateFields & {
      walletId: string;
      amountToken: number;
      remainingAmountToken: number | null;
      highWaterMarkUsd: number | null;
      entryPriceUsd: number;
      stopLossPercent: number | null;
      stopLossIsSystemDefault: boolean;
      wallet: { publicKey: string; encryptedSecret: string };
    },
  ): Promise<void> {
    try {
      // 2026-07-21 audit (section E1): proactive, price-independent check
      // that this position's wallet still actually holds tokens — before
      // this fix, a position whose SELL had already succeeded on-chain
      // (but whose verification step failed, e.g. a transient RPC hiccup)
      // could stay OPEN indefinitely: the DB-vs-wallet reconciliation
      // logic already existed inside PositionManager.closePositionLocked
      // (the "wallet holds 0 of this token" branch) but was only ever
      // reached as a side effect of a TP/SL-triggered sell attempt. Seven
      // real production positions sat OPEN for up to 8 days this way
      // because their price never moved enough to trigger one. This
      // check runs every tick, for every open position, independent of
      // price — reads only the wallet's already-plaintext public key, no
      // secret ever touched. Cheap (one RPC call) at today's scale (~12
      // open positions).
      if (await this.reconcileIfWalletEmpty(position)) return;

      const pair = await this.deps.dexScreener.getBestSolanaPair(position.token.mint);
      let currentPriceUsd = pair?.priceUsd ? Number(pair.priceUsd) : undefined;
      if (currentPriceUsd === undefined || !Number.isFinite(currentPriceUsd)) {
        currentPriceUsd = await this.handleMissingPrice(position);
        if (currentPriceUsd === undefined) return;
      } else {
        this.noPriceState.delete(position.id);
        await this.clearMonitoringStateIfNeeded(position);
      }

      // Emergency liquidity-deterioration detection (2026-07-23, USOH
      // incident follow-up, requirement #12): a signal only — feeds into the
      // SAME stop-loss/hard-ceiling decision below via an extra corroboration
      // source, never an independent forced-sell path. See
      // probeLiquidityCollapse's own doc comment.
      const liquidityCollapse = await this.probeLiquidityCollapse(position.token, currentPriceUsd);
      if (liquidityCollapse.collapsed) {
        this.deps.logger.warn(
          {
            positionId: position.id,
            mint: position.token.mint,
            liquidityUsd: liquidityCollapse.liquidityUsd,
            referenceLiquidityUsd: liquidityCollapse.referenceLiquidityUsd,
          },
          'liquidity deterioration detected for open position — treated as corroboration for a price crash, never an independent forced exit',
        );
        // Immediate alert (2026-07-23, requirement #9) — deduped per position
        // for an hour, same TTL convention as every other alert in this file,
        // so a sustained collapse doesn't spam on every 15s tick.
        if (!this.stalePriceAlerted.has(`liquidity_collapse:${position.id}`)) {
          this.stalePriceAlerted.add(`liquidity_collapse:${position.id}`);
          await this.deps.notifier?.notifyError(
            'liquidity collapse detected',
            `Position ${position.id} (${position.token.symbol ?? position.token.mint}): on-chain liquidity dropped to $${liquidityCollapse.liquidityUsd?.toFixed(2)} from a reference of $${liquidityCollapse.referenceLiquidityUsd?.toFixed(2)} — treated as corroboration for the current price reading, never an independent forced sell. Stop-loss/hard-loss-ceiling logic will act on it if the configured threshold is actually breached.`,
          );
        }
      }

      // Reject an implausible single-tick outlier before it can corrupt this
      // position's (monotonic, self-reinforcing) high-water mark or fire a
      // bogus exit off a phantom price — see exitEngine.ts's
      // isPlausiblePriceUpdate doc comment for the live-verified incident.
      const referencePriceUsd = position.highWaterMarkUsd ?? position.entryPriceUsd;
      if (!isPlausiblePriceUpdate(referencePriceUsd, currentPriceUsd)) {
        // Hard Loss Ceiling (2026-07-18): a rejected tick doesn't wait for
        // the normal 3-rejection/10-minute reconciliation cycle if it
        // already implies a loss beyond this position's ceiling — that
        // wait is exactly what let a real position (ANSEMCOIN) sit
        // unprotected for hours before its stop-loss could even see a
        // real price. Cheap arithmetic first; only pays for a
        // corroboration probe when the answer is yes.
        const hardLoss = evaluateHardLossCeiling(
          position.entryPriceUsd,
          currentPriceUsd,
          position.stopLossPercent ?? DEFAULT_MAX_LOSS_PERCENT, // defensive fallback — Step 3 means this is always populated
        );
        if (hardLoss.breached) {
          const reconciliation = await this.probeAndReconcile(
            position.token,
            currentPriceUsd,
            false,
            liquidityCollapse.collapsed,
          );
          if (reconciliation.accepted) {
            this.outlierState.delete(position.id);
            this.deps.logger.error(
              {
                positionId: position.id,
                mint: position.token.mint,
                entryPriceUsd: position.entryPriceUsd,
                currentPriceUsd,
                pnlPercent: hardLoss.pnlPercent,
                effectiveStopLossPercent: position.stopLossPercent,
                isSystemDefault: position.stopLossIsSystemDefault,
                source: reconciliation.source,
                liquidityCollapseCorroborated: liquidityCollapse.collapsed,
              },
              'HARD_LOSS_CEILING_TRIGGERED — forcing immediate exit ahead of normal outlier reconciliation',
            );
            await this.deps.positionManager.closePosition(
              position.id,
              position.walletId,
              position.wallet.encryptedSecret,
              this.deps.encryptionKey,
              { currentPriceUsd, reason: 'stop_loss' },
            );
            return;
          }
          // Not corroborated — fall through to the routine path below unchanged.
        }

        const accepted = await this.handleOutlierRejection(
          position.id,
          position.token,
          referencePriceUsd,
          currentPriceUsd,
          liquidityCollapse.collapsed,
        );
        if (!accepted) return;
      }
      this.outlierState.delete(position.id);

      await this.deps.positionManager.checkAndMaybeClose(
        position.id,
        currentPriceUsd,
        position.wallet.encryptedSecret,
        this.deps.encryptionKey,
      );
    } catch (err) {
      // Production Bug Fix (2026-07-14): this catch previously covered both
      // a DexScreener price-fetch failure above AND a SELL execution
      // failure from checkAndMaybeClose below under the same generic
      // message, with no way to tell which happened or why from the log
      // line alone. PositionManager tags every SELL failure it throws
      // with `.sellFailureCategory` (see sellFailureClassifier.ts) — when
      // present, log it as a distinct, categorized SELL failure instead.
      const category = (err as { sellFailureCategory?: string } | null)?.sellFailureCategory;
      if (category) {
        this.deps.logger.error(
          { err, positionId: position.id, mint: position.token.mint, category },
          `SELL execution failed [${category}]`,
        );
      } else {
        this.deps.logger.error(
          { err, positionId: position.id },
          'price check failed for open position',
        );
      }
    }
  }

  /**
   * Reads the wallet's real on-chain balance for this position's token — a
   * plaintext-public-key-only read, no secret ever touched — and, if it's
   * zero while the position is recorded as still holding tokens, hands off
   * to PositionManager.closePosition, which already contains the correct
   * "wallet holds 0 of this token" reconciliation branch (no fabricated PnL,
   * records a reconciliation trade note, alerts). Returns true when the
   * position was reconciled (caller should skip the rest of this tick for
   * it) or when the balance check itself couldn't run (no connection wired —
   * matches this dep's optional/test-fixture convention); false when the
   * wallet genuinely still holds tokens and normal price-based processing
   * should continue.
   */
  private async reconcileIfWalletEmpty(position: {
    id: string;
    walletId: string;
    amountToken: number;
    remainingAmountToken: number | null;
    highWaterMarkUsd: number | null;
    entryPriceUsd: number;
    wallet: { publicKey: string; encryptedSecret: string };
    token: { mint: string };
  }): Promise<boolean> {
    if (!this.deps.connection) return false;
    const expectedAmount = position.remainingAmountToken ?? position.amountToken;
    if (expectedAmount <= 0) return false;
    let realBalance: bigint;
    try {
      realBalance = await getRealTokenBalance(
        this.deps.connection,
        position.wallet.publicKey,
        position.token.mint,
      );
    } catch (err) {
      this.deps.logger.debug(
        { err, positionId: position.id, mint: position.token.mint },
        'proactive zero-balance reconciliation: balance read failed, will retry next tick',
      );
      return false;
    }
    if (realBalance > 0n) return false;

    this.deps.logger.warn(
      { positionId: position.id, mint: position.token.mint, expectedAmount },
      'proactive reconciliation: wallet holds 0 of this token for a position recorded OPEN — closing to stop it sitting stale',
    );
    await this.deps.positionManager.closePosition(
      position.id,
      position.walletId,
      position.wallet.encryptedSecret,
      this.deps.encryptionKey,
      { currentPriceUsd: position.highWaterMarkUsd ?? position.entryPriceUsd, reason: 'stop_loss' },
    );
    this.outlierState.delete(position.id);
    this.noPriceState.delete(position.id);
    return true;
  }

  /**
   * 2026-07-21 audit (section E2): DexScreener returning nothing for a token
   * used to be a silent, untracked, permanent skip — the exact reason a
   * position ("pinheads") sat unmonitored even though a live, 0%-impact
   * Jupiter sell route existed for it the entire time. Falls back to the
   * same reverse-quote probe already used for outlier corroboration. Returns
   * a usable price if the fallback found one, else undefined (caller should
   * skip this tick as before).
   *
   * 2026-07-22 audit (repeated "over 10 minutes" alert spam): the elapsed-time
   * clock and alert dedup used to live in this.noPriceState/stalePriceAlerted
   * — in-memory only, so every process restart reset "how long has this been
   * going on" back to zero, which is exactly why a position that had already
   * been alerted at 70 and 130 minutes kept re-reporting "over 10 minutes"
   * after each of that day's several deploys. That tracking now lives on the
   * Position row itself (see recordMonitoringIssue) and survives a restart.
   */
  private async handleMissingPrice(position: MonitoringStateFields): Promise<number | undefined> {
    const fallbackPriceUsd = await this.probeJupiterReversePrice(position.token);
    if (fallbackPriceUsd !== undefined) {
      this.noPriceState.delete(position.id);
      this.deps.logger.info(
        { positionId: position.id, mint: position.token.mint, fallbackPriceUsd },
        'DexScreener had no price — used Jupiter reverse-quote fallback instead',
      );
      await this.clearMonitoringStateIfNeeded(position);
      return fallbackPriceUsd;
    }

    const state = this.noPriceState.get(position.id) ?? { count: 0 };
    state.count += 1;
    this.noPriceState.set(position.id, state);

    const newState = await this.classifyMissingSellRoute(position.token);
    const elapsedMs = await this.recordMonitoringIssue(position, newState);

    this.deps.logger.warn(
      {
        positionId: position.id,
        mint: position.token.mint,
        consecutiveMisses: state.count,
        elapsedMs,
        monitoringState: newState,
      },
      'no price available for open position this tick (DexScreener empty, no Jupiter route) — skipping',
    );

    return undefined;
  }

  /**
   * Distinguishes a real, confirmed "no route exists" (a genuine, resolved
   * Jupiter answer — e.g. HTTP 400 NO_ROUTES_FOUND) from a merely-unavailable
   * or transient probe failure, same classification sellabilityCheck.ts
   * already uses for the pre-buy check — reused here so a position whose
   * exit route is definitively gone gets the more specific, more actionable
   * NO_SELL_ROUTE diagnosis instead of the generic PRICE_UNAVAILABLE.
   */
  private async classifyMissingSellRoute(
    token: Token,
  ): Promise<'NO_SELL_ROUTE' | 'PRICE_UNAVAILABLE'> {
    if (!this.deps.jupiter) return 'PRICE_UNAVAILABLE';
    try {
      const amountToken = Math.max(1, Math.floor(10 ** token.decimals * 0.01));
      await this.deps.jupiter.getQuote({
        inputMint: token.mint,
        outputMint: SOL_MINT,
        amountLamports: BigInt(amountToken),
        slippageBps: 500,
      });
      // A quote came back but probeJupiterReversePrice's own (stricter, USD-
      // conversion-dependent) attempt already failed — treat as unresolved
      // rather than claiming a confirmed route exists.
      return 'PRICE_UNAVAILABLE';
    } catch (err) {
      return isTransientQuoteError(err) ? 'PRICE_UNAVAILABLE' : 'NO_SELL_ROUTE';
    }
  }

  /**
   * Persists the current diagnostic state and elapsed-episode clock on the
   * Position row itself (see Position.monitoringState in schema.prisma) and
   * decides whether to send a Telegram alert — this is the actual
   * restart-proof replacement for the old in-memory tracking. Returns the
   * elapsed episode duration in ms, for logging.
   *
   * Alert cadence: nothing before STALE_PRICE_ALERT_AFTER_MS (10 min, same as
   * before); then exactly one alert, then silence until either the
   * diagnostic state materially changes (e.g. PRICE_UNAVAILABLE ->
   * NO_SELL_ROUTE) or staleReminderIntervalMs has passed since the last
   * alert (a configurable long-interval reminder for a still-unresolved
   * position, never one per tick).
   */
  private async recordMonitoringIssue(
    position: MonitoringStateFields,
    newState: 'PRICE_UNAVAILABLE' | 'NO_SELL_ROUTE',
  ): Promise<number> {
    const now = new Date();
    const wasNormal = position.monitoringState === 'NORMAL';
    // A move between two non-NORMAL states (e.g. PRICE_UNAVAILABLE ->
    // NO_SELL_ROUTE) is a refined diagnosis of the SAME outage episode, not a
    // new one — only leaving NORMAL starts a fresh clock.
    const episodeSince =
      wasNormal || !position.monitoringStateSince ? now : position.monitoringStateSince;
    const elapsedMs = now.getTime() - episodeSince.getTime();

    // Escalate to MANUAL_REVIEW after a long enough sustained NO_SELL_ROUTE —
    // a stronger diagnostic flag only; never touches status/closes anything.
    const effectiveState: PositionMonitoringState =
      newState === 'NO_SELL_ROUTE' && elapsedMs >= this.manualReviewAfterMs
        ? 'MANUAL_REVIEW'
        : newState;

    if (position.monitoringState !== effectiveState || position.monitoringStateSince === null) {
      await this.deps.prisma.position.update({
        where: { id: position.id },
        data: { monitoringState: effectiveState, monitoringStateSince: episodeSince },
      });
    }

    if (elapsedMs < STALE_PRICE_ALERT_AFTER_MS) return elapsedMs;

    const stateChangedSinceLastAlert = position.lastAlertedMonitoringState !== effectiveState;
    const reminderDue =
      position.lastMonitoringAlertAt !== null &&
      now.getTime() - position.lastMonitoringAlertAt.getTime() >= this.staleReminderIntervalMs;
    const neverAlerted = position.lastMonitoringAlertAt === null;

    if (!(neverAlerted || stateChangedSinceLastAlert || reminderDue)) return elapsedMs;

    await this.deps.prisma.position.update({
      where: { id: position.id },
      data: { lastMonitoringAlertAt: now, lastAlertedMonitoringState: effectiveState },
    });

    const label =
      effectiveState === 'MANUAL_REVIEW'
        ? 'a confirmed no-sell-route, unresolved long enough to need manual review'
        : effectiveState === 'NO_SELL_ROUTE'
          ? 'no usable price and a confirmed no-sell-route'
          : 'no usable price';
    await this.deps.notifier?.notifyError(
      'stale price feed',
      `Position ${position.id} (${position.token.symbol ?? position.token.mint}) has had ${label} for over ${Math.round(elapsedMs / 60_000)} minutes — DexScreener has no pair and no Jupiter sell route was found either.`,
    );
    return elapsedMs;
  }

  /**
   * A position that recovers (price or sell route becomes available again)
   * resets its monitoring state back to NORMAL and gets an explicit
   * "recovered" notification — never left in a stale non-NORMAL state once
   * it's genuinely usable again.
   */
  private async clearMonitoringStateIfNeeded(position: MonitoringStateFields): Promise<void> {
    if (position.monitoringState === 'NORMAL') return;
    const previousState = position.monitoringState;
    await this.deps.prisma.position.update({
      where: { id: position.id },
      data: {
        monitoringState: 'NORMAL',
        monitoringStateSince: null,
        lastMonitoringAlertAt: null,
        lastAlertedMonitoringState: null,
      },
    });
    await this.deps.notifier?.notifyError(
      'stale price feed recovered',
      `Position ${position.id} (${position.token.symbol ?? position.token.mint}) has a usable price/sell route again after being ${previousState} — monitoring state cleared.`,
    );
  }

  /**
   * Root-cause fix (2026-07-18) for a position being starved of price
   * updates indefinitely by a stale/corrupted reference price: only reaches
   * here once a tick has already failed isPlausiblePriceUpdate. Below the
   * consecutive-rejection/elapsed-time thresholds, keeps today's exact
   * behavior (log + skip this tick). Once past them, cross-checks the
   * candidate against a second, independently-sourced price read before
   * accepting it — and after OUTLIER_FORCE_ACCEPT_AFTER_MS of sustained
   * rejection with no corroboration, accepts it anyway so a genuine sustained
   * crash is never misclassified as bad data forever. Returns whether the
   * caller should now treat currentPriceUsd as accepted.
   */
  private async handleOutlierRejection(
    positionId: string,
    token: Token,
    referencePriceUsd: number,
    currentPriceUsd: number,
    liquidityDropCorroborates = false,
  ): Promise<boolean> {
    const state = this.outlierState.get(positionId) ?? { count: 0, firstRejectedAt: Date.now() };
    state.count += 1;
    this.outlierState.set(positionId, state);
    const elapsedMs = Date.now() - state.firstRejectedAt;

    const shouldAttemptReconciliation =
      state.count >= OUTLIER_RECONCILE_AFTER_CONSECUTIVE_REJECTIONS ||
      elapsedMs >= OUTLIER_FORCE_ACCEPT_AFTER_MS;

    if (!shouldAttemptReconciliation) {
      this.deps.logger.warn(
        {
          positionId,
          mint: token.mint,
          referencePriceUsd,
          currentPriceUsd,
          consecutiveRejections: state.count,
        },
        'price tick rejected as implausible outlier — skipping this position this tick',
      );
      return false;
    }

    const forcedAfterCeiling = elapsedMs >= OUTLIER_FORCE_ACCEPT_AFTER_MS;
    const reconciliation = await this.probeAndReconcile(
      token,
      currentPriceUsd,
      forcedAfterCeiling,
      liquidityDropCorroborates,
    );

    if (!reconciliation.accepted) {
      this.deps.logger.warn(
        {
          positionId,
          mint: token.mint,
          referencePriceUsd,
          currentPriceUsd,
          consecutiveRejections: state.count,
        },
        'price tick rejected as implausible outlier — reconciliation attempted but no independent source corroborated it',
      );
      return false;
    }

    // A distinct, loud line — never confused with the routine rejection
    // above — so a human reviewing logs sees exactly when and why a
    // previously-stuck position's reference price was overridden. Also
    // Telegram-alerted (2026-07-21 audit, section F) — this is exactly the
    // "repeated price ticks rejected" condition the brief asked to surface,
    // previously logged only.
    this.deps.logger.error(
      {
        positionId,
        mint: token.mint,
        referencePriceUsd,
        currentPriceUsd,
        consecutiveRejections: state.count,
        elapsedMs,
        source: reconciliation.source,
      },
      reconciliation.source === 'forced_after_ceiling'
        ? `PRICE OUTLIER FORCE-ACCEPTED after ${OUTLIER_FORCE_ACCEPT_AFTER_MS}ms of sustained rejection with no corroborating source — a genuine sustained move is assumed over indefinite starvation`
        : `PRICE OUTLIER RECONCILED — accepting tick, corroborated by ${reconciliation.source}`,
    );
    if (!this.stalePriceAlerted.has(`outlier:${positionId}`)) {
      this.stalePriceAlerted.add(`outlier:${positionId}`);
      await this.deps.notifier?.notifyError(
        'repeated price outlier rejection',
        `Position ${positionId} (${token.symbol ?? token.mint}) had ${state.count} consecutive rejected price ticks (reference $${referencePriceUsd} vs candidate $${currentPriceUsd}) before being ${reconciliation.source === 'forced_after_ceiling' ? 'force-accepted after the time ceiling' : `reconciled via ${reconciliation.source}`}.`,
      );
    }
    return true;
  }

  /**
   * Runs both independent price-corroboration probes and hands the result to
   * reconcilePriceOutlier — shared by handleOutlierRejection's normal
   * 3-rejection/10-minute cycle and the Hard Loss Ceiling fast path (2026-07-18),
   * which calls this immediately on a single rejection instead of waiting.
   * Extracted so the two call sites can't drift apart on how corroboration
   * actually works.
   */
  private async probeAndReconcile(
    token: Token,
    candidatePriceUsd: number,
    forcedAfterCeiling: boolean,
    liquidityDropCorroborates = false,
  ): Promise<PriceReconciliationResult> {
    const [jupiterReverseQuotePriceUsd, nativeDexReservesPriceUsd] = await Promise.all([
      this.probeJupiterReversePrice(token),
      this.probeNativeDexPrice(token),
    ]);
    return reconcilePriceOutlier({
      candidatePriceUsd,
      jupiterReverseQuotePriceUsd,
      nativeDexReservesPriceUsd,
      forcedAfterCeiling,
      liquidityDropCorroborates,
    });
  }

  /**
   * Emergency liquidity-deterioration detection (2026-07-23, USOH incident
   * follow-up, requirement #12): compares the token's current DexScreener
   * liquidity against its last-known-good value on file (Token.liquidityUsd,
   * updated on every accepted tick elsewhere in the pipeline) — a drop past
   * `collapseRatio` (default: liquidity fell to 20% or less of its reference)
   * is treated as a real, corroborating signal that a price crash is genuine,
   * not a bad reading. Deliberately narrow: this NEVER triggers a sell by
   * itself — it only feeds reconcilePriceOutlier as one more independent
   * source, so the actual exit still goes through the position's own
   * configured stop-loss (evaluateHardLossCeiling upstream in
   * processPosition). Returns collapsed:false (never throws) on any read
   * failure — an unresolved liquidity comparison is not evidence of anything.
   */
  private async probeLiquidityCollapse(
    token: Token,
    currentPriceUsd: number,
  ): Promise<{ collapsed: boolean; liquidityUsd?: number; referenceLiquidityUsd?: number }> {
    const referenceLiquidityUsd = token.liquidityUsd;
    if (
      referenceLiquidityUsd === null ||
      !Number.isFinite(referenceLiquidityUsd) ||
      referenceLiquidityUsd <= 0
    ) {
      return { collapsed: false };
    }
    try {
      const pair = await this.deps.dexScreener.getBestSolanaPair(token.mint);
      const liquidityUsd = pair?.liquidity?.usd;
      if (liquidityUsd === undefined || !Number.isFinite(liquidityUsd)) {
        return { collapsed: false, referenceLiquidityUsd };
      }
      const collapseRatio = 0.2;
      const collapsed = liquidityUsd <= referenceLiquidityUsd * collapseRatio;
      return { collapsed, liquidityUsd, referenceLiquidityUsd };
    } catch (err) {
      this.deps.logger.debug(
        { mint: token.mint, err, currentPriceUsd },
        'liquidity-collapse probe failed',
      );
      return { collapsed: false, referenceLiquidityUsd };
    }
  }

  /**
   * A reverse (token -> SOL) Jupiter quote at a small slice of the position's
   * own holdings, converted to a USD-per-token price via the shared SOL/USD
   * oracle — same math already used by PositionManager.resolveEntryPriceUsd,
   * reused here as one of two independent price sources for outlier
   * reconciliation (see exitEngine.ts's reconcilePriceOutlier), and (2026-07-21
   * audit) as the missing-price fallback in handleMissingPrice above.
   */
  private async probeJupiterReversePrice(token: Token): Promise<number | undefined> {
    if (!this.deps.jupiter) return undefined;
    try {
      const amountToken = Math.max(1, Math.floor(10 ** token.decimals * 0.01));
      const [quote, solPriceUsd] = await Promise.all([
        this.deps.jupiter.getQuote({
          inputMint: token.mint,
          outputMint: SOL_MINT,
          amountLamports: BigInt(amountToken),
          slippageBps: 500,
        }),
        sharedSolPriceOracle.getPriceUsd(this.deps.dexScreener),
      ]);
      if (solPriceUsd === undefined) return undefined;
      const solReceived = Number(quote.outAmount) / 1e9;
      const tokensSold = amountToken / 10 ** token.decimals;
      if (tokensSold <= 0) return undefined;
      const priceUsd = (solReceived * solPriceUsd) / tokensSold;
      return Number.isFinite(priceUsd) && priceUsd > 0 ? priceUsd : undefined;
    } catch (err) {
      this.deps.logger.debug(
        { mint: token.mint, err },
        'outlier reconciliation: jupiter reverse-quote probe failed',
      );
      return undefined;
    }
  }

  /**
   * Derives a price from a native DEX pool's own reserve ratio (base/quote
   * vault balances), when the token's pool is known — the second independent
   * source for outlier reconciliation. Only ever resolves for tokens whose
   * dex/poolAddress map to one of DexRegistry's four native monitors; returns
   * undefined (never throws) for anything else, including pre-migration
   * pump.fun bonding-curve tokens.
   */
  private async probeNativeDexPrice(token: Token): Promise<number | undefined> {
    if (!this.deps.dexRegistry || !token.poolAddress) return undefined;
    try {
      const pool = await this.deps.dexRegistry.getLiquidity(token.dex, token.poolAddress);
      if (!pool || pool.baseReserve <= 0 || pool.quoteReserve <= 0) return undefined;
      if (pool.baseMint !== token.mint) return undefined;

      if (pool.quoteMint === SOL_MINT) {
        const solPriceUsd = await sharedSolPriceOracle.getPriceUsd(this.deps.dexScreener);
        if (solPriceUsd === undefined) return undefined;
        return (pool.quoteReserve / pool.baseReserve) * solPriceUsd;
      }
      // Any other quote mint in this codebase's native pools is a USD-pegged
      // stablecoin — the reserve ratio is already ~USD per token.
      return pool.quoteReserve / pool.baseReserve;
    } catch (err) {
      this.deps.logger.debug(
        { mint: token.mint, err },
        'outlier reconciliation: native DEX reserve probe failed',
      );
      return undefined;
    }
  }
}
