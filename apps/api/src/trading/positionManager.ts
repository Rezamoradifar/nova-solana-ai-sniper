import { randomBytes } from 'node:crypto';
import bs58 from 'bs58';
import { Connection, Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { getMint } from '@solana/spl-token';
import type { Dex, PrismaClient } from '@prisma/client';
import { unsealKeypair, type Logger } from '@nova/shared';
import type { NotificationService } from '@nova/telegram-bot';
import { JupiterClient, SOL_MINT } from '../solana/jupiter.js';
import type { DexScreenerClient } from '../solana/dexscreener.js';
import { sharedSolPriceOracle, type SolPriceOracle } from '../solana/pumpfunBondingCurve.js';
import type { DexRegistry } from '../solana/dex/registry.js';
import { JitoClient } from '../solana/jito.js';
import { evaluateExit, type ExitReason } from './exitEngine.js';
import { computeTrailingStopDisplay, defaultExitParams } from './adaptiveTrailingStop.js';
import { eventBus } from '../lib/eventBus.js';
import { TradingSafety, SafetyCheckError } from './safety.js';

const LAMPORTS_PER_SOL = 1_000_000_000;
const DEFAULT_MAX_PRIORITY_FEE_LAMPORTS = 1_000_000;
// Modest fixed tip — Jito bundles need a nonzero tip to be considered by
// validators, but this is a fallback-with-graceful-degradation path (a rejected
// or unlanded bundle just falls through to a plain send), not the only way a
// trade can land, so a small fixed amount is a reasonable default over adding
// another tunable for this pass.
const JITO_TIP_LAMPORTS = 100_000;

/**
 * Never trust a pre-trade Jupiter quote for bookkeeping — actual execution almost
 * always differs slightly from the estimate. Reads what actually landed in the
 * wallet from the confirmed transaction's own balance snapshot.
 */
async function getActualTokenDelta(
  connection: Connection,
  signature: string,
  ownerPubkey: string,
  mint: string,
): Promise<bigint> {
  const tx = await connection.getParsedTransaction(signature, {
    maxSupportedTransactionVersion: 0,
    commitment: 'confirmed',
  });
  if (!tx?.meta) {
    throw new Error(
      `Could not fetch confirmed transaction ${signature} to verify the actual amount received`,
    );
  }
  const findAmount = (balances: typeof tx.meta.postTokenBalances) =>
    balances?.find((b) => b.owner === ownerPubkey && b.mint === mint)?.uiTokenAmount.amount;

  const pre = BigInt(findAmount(tx.meta.preTokenBalances) ?? '0');
  const post = BigInt(findAmount(tx.meta.postTokenBalances) ?? '0');
  return post - pre;
}

/**
 * The verification RPC call (getParsedTransaction) frequently fails with
 * "Could not fetch confirmed transaction" for a few seconds right after a
 * swap lands — the tx is confirmed on-chain but hasn't propagated to the RPC
 * node's own view yet. Live-verified 2026-07-11: two real production BUYs
 * landed on-chain and failed verification on the first attempt with exactly
 * this transient error, permanently locking that wallet+token pair out of
 * further auto-buys (see unverifiedSwapLocks) even though the transaction
 * was simply not yet visible. Retrying a few times with a short delay before
 * giving up fixes the root cause instead of just working around its effect.
 */
async function withVerificationRetry<T>(
  fn: () => Promise<T>,
  attempts = 3,
  delayMs = 2000,
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1 && delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastErr;
}

/** Same idea as getActualTokenDelta, but for native SOL (lamports), which isn't an SPL token balance. */
async function getActualSolDelta(
  connection: Connection,
  signature: string,
  ownerPubkey: string,
): Promise<bigint> {
  const tx = await connection.getParsedTransaction(signature, {
    maxSupportedTransactionVersion: 0,
    commitment: 'confirmed',
  });
  if (!tx?.meta) {
    throw new Error(
      `Could not fetch confirmed transaction ${signature} to verify the actual amount received`,
    );
  }
  const accountIndex = tx.transaction.message.accountKeys.findIndex(
    (k) => k.pubkey.toBase58() === ownerPubkey,
  );
  if (accountIndex === -1) {
    throw new Error(`Owner ${ownerPubkey} not found in transaction ${signature}`);
  }
  // The signer is also the fee payer, so this delta is already net of the network fee.
  return BigInt(tx.meta.postBalances[accountIndex]!) - BigInt(tx.meta.preBalances[accountIndex]!);
}

/**
 * The wallet's real, current on-chain balance of a token — the only safe source
 * of truth for "how much can we actually sell." Never sell a stored/estimated
 * amount without checking this first.
 */
async function getRealTokenBalance(
  connection: Connection,
  ownerPubkey: string,
  mint: string,
): Promise<bigint> {
  const resp = await connection.getParsedTokenAccountsByOwner(new PublicKey(ownerPubkey), {
    mint: new PublicKey(mint),
  });
  if (resp.value.length === 0) return 0n;
  return BigInt(resp.value[0]!.account.data.parsed.info.tokenAmount.amount);
}

export interface OpenPositionParams {
  userId: string;
  walletId: string;
  walletPublicKey: string;
  encryptedSecret: string;
  encryptionKey: string;
  tokenId: string;
  mint: string;
  symbol?: string;
  amountSol: number;
  slippageBps: number;
  takeProfitPercent?: number;
  stopLossPercent?: number;
  trailingStopPercent?: number;
  /** Optional exit strategy — see adaptiveTrailingStop.ts. Frozen onto the Position at open time. */
  trailingStopPreset?: string;
  /** Display-only, for the BUY trade card — the score that actually gated this buy. */
  aiScore?: number;
}

/** A random-looking signature so paper trades are visually distinct from real (base58) ones. */
function paperSignature(): string {
  return `PAPER${randomBytes(16).toString('hex')}`;
}

export class PositionManager {
  private readonly solPriceOracle: SolPriceOracle = sharedSolPriceOracle;

  /**
   * Guards against re-submitting a brand-new swap for a position/wallet+token
   * whose previous attempt already landed on-chain but couldn't be verified
   * (getActualTokenDelta/getActualSolDelta itself failing, e.g. an RPC outage
   * right after the swap confirmed). Without this, the swap's own on-chain
   * effect is real and done, but the DB never learns about it (recordFailedTrade
   * has no signature to store), so the position stays OPEN with its original
   * amountToken untouched — and PriceMonitor's next tick (or a retried manual
   * buy) sees the same "still needs to execute" state and submits ANOTHER real
   * swap. closePosition's own realBalance-vs-recordedAmount cap prevents any
   * single resubmit from overselling past the wallet's actual balance, but does
   * nothing to stop a second, third, Nth resubmit from each selling another
   * full recordedAmount out of whatever balance is left — which is exactly what
   * happened live on 2026-07-11: 3 consecutive verification-RPC failures on one
   * position produced 3 separate real on-chain sells of the same amount, 2 of
   * which drained tokens that had nothing to do with the position being closed.
   * Keyed by positionId for sells, `${walletId}:${tokenId}` for buys (no
   * positionId exists yet at buy time). Deliberately process-lifetime only, not
   * persisted — see the doc comment on the catch blocks that set it.
   *
   * Value is the timestamp the lock was set. A lock is never permanent: after
   * RECONCILIATION_LOCK_TTL_MS it auto-expires and trading recovers on its
   * own (see isLockActive). Root-cause investigation 2026-07-12 found the
   * previous Set-based version blocked a wallet+token pair forever once a
   * single verification RPC call failed, with no recovery path short of a
   * full process restart — a real "no buy ever executes again for this pair"
   * bug, not a deliberate safety gate.
   */
  private readonly unverifiedSwapLocks = new Map<string, number>();

  /** How long a stuck reconciliation lock is honored before auto-recovering. */
  private static readonly RECONCILIATION_LOCK_TTL_MS = 10 * 60 * 1000;

  /**
   * Checks (and lazily clears) a reconciliation lock. Never permanently blocks
   * trading: once the TTL elapses, the lock is treated as stale and removed
   * automatically, with an explicit log line explaining the recovery.
   */
  private isLockActive(key: string): boolean {
    const lockedAt = this.unverifiedSwapLocks.get(key);
    if (lockedAt === undefined) return false;
    const lockedForMs = Date.now() - lockedAt;
    if (lockedForMs < PositionManager.RECONCILIATION_LOCK_TTL_MS) return true;
    this.logger.warn(
      { key, lockedForMs },
      'unverifiedSwapLocks: reconciliation lock expired — automatically recovering, trading is no longer blocked for this key',
    );
    this.unverifiedSwapLocks.delete(key);
    return false;
  }

  constructor(
    private readonly prisma: PrismaClient,
    private readonly connection: Connection,
    private readonly jupiter: JupiterClient,
    private readonly dexScreener: DexScreenerClient,
    private readonly logger: Logger,
    private readonly safety: TradingSafety,
    private readonly notifier?: NotificationService,
    /** Real swaps only ever execute when this is explicitly false (LIVE_TRADING=true). */
    private readonly paperTrading: boolean = true,
    /** Optional: enables a native-DEX fallback when Jupiter can't route a live swap. */
    private readonly dexRegistry?: DexRegistry,
    /** Optional: gated on JITO_BLOCK_ENGINE_URL being configured; unset means every send goes direct. */
    private readonly jito?: JitoClient,
    private readonly maxPriorityFeeLamports: number = DEFAULT_MAX_PRIORITY_FEE_LAMPORTS,
    /** Delay between verification retries (withVerificationRetry) — overridable so tests don't wait on real timers. */
    private readonly verificationRetryDelayMs: number = 2000,
  ) {}

  /**
   * Sends a signed transaction via a Jito bundle (tip + swap) when Jito is
   * configured, falling back to a plain direct send if bundle submission fails —
   * Jito can never be the reason a trade doesn't happen. Confirmation uses the
   * swap transaction's own signature either way, since a Jito-landed transaction
   * still appears on-chain under its normal signature once it lands.
   */
  private async broadcastTransaction(
    transaction: VersionedTransaction,
    signer: Keypair,
  ): Promise<string> {
    const signature = bs58.encode(transaction.signatures[0]!);

    if (this.jito) {
      try {
        const { blockhash } = await this.connection.getLatestBlockhash();
        const tipTx = JitoClient.buildTipTransaction(signer, JITO_TIP_LAMPORTS, blockhash);
        await this.jito.sendBundle([tipTx, transaction]);
        const confirmation = await this.connection.confirmTransaction(signature, 'confirmed');
        if (confirmation.value.err) {
          throw new Error(
            `Transaction ${signature} landed but reverted on-chain: ${JSON.stringify(confirmation.value.err)}`,
          );
        }
        return signature;
      } catch (err) {
        this.logger.warn({ err }, 'Jito bundle submission failed — falling back to a direct send');
      }
    }

    await this.connection.sendTransaction(transaction);
    // A confirmed transaction can still have landed with an on-chain error (e.g.
    // slippage exceeded, a program-level revert) — confirmTransaction only rejects
    // on timeout/expiry, never on this. Live-verified gap: without this check, a
    // reverted swap was recorded as a successful buy/sell (a Position "opened"
    // with 0 tokens actually received, or "closed" with a fabricated PnL) since
    // getActualTokenDelta/getActualSolDelta both computed a real delta of 0/refund
    // rather than surfacing the revert itself.
    const confirmation = await this.connection.confirmTransaction(signature, 'confirmed');
    if (confirmation.value.err) {
      throw new Error(
        `Transaction ${signature} landed but reverted on-chain: ${JSON.stringify(confirmation.value.err)}`,
      );
    }
    return signature;
  }

  /**
   * Best-effort durability record for a live swap attempt that never reached (or
   * was reverted after) broadcastTransaction — previously such attempts left no
   * Trade row at all, only a log line, so a failed buy/sell was invisible in Trade
   * History. Never throws itself: a DB hiccup while recording a failure must not
   * mask the original error from the caller.
   */
  private async recordFailedTrade(params: {
    walletId: string;
    tokenId: string;
    side: 'BUY' | 'SELL';
    amountSol: number;
    amountToken?: number;
    slippageBps?: number;
    /** Set when the swap itself actually landed on-chain and only later verification
     *  failed — without this, a real, successful on-chain transaction was recorded
     *  with no signature at all, making it nearly impossible to find/reconcile later. */
    signature?: string;
    err: unknown;
  }): Promise<void> {
    try {
      await this.prisma.trade.create({
        data: {
          walletId: params.walletId,
          tokenId: params.tokenId,
          side: params.side,
          status: 'FAILED',
          amountSol: params.amountSol,
          amountToken: params.amountToken,
          txSignature: params.signature,
          slippageBps: params.slippageBps ?? 100,
          isPaperTrade: false,
        },
      });
    } catch (recordErr) {
      this.logger.error(
        { recordErr, originalErr: params.err, side: params.side, tokenId: params.tokenId },
        'failed to record a FAILED trade attempt',
      );
    }
  }

  /**
   * Jupiter first, always — it already aggregates every DEX this platform knows
   * about and is the far more battle-tested path. Only on a Jupiter failure (e.g.
   * "no route found," which can happen for a token that's too new for Jupiter's
   * indexer to have picked up yet) does this fall back to a native DEX executor,
   * and only if one is registered and the token's pool is known. The native
   * builder's own simulation gate (mirroring JupiterClient.prepareSwap's) means a
   * malformed fallback transaction is caught here, never sent.
   */
  private async sendSwap(
    keypair: Keypair,
    swapParams: {
      inputMint: string;
      outputMint: string;
      amountLamports: bigint;
      slippageBps: number;
    },
    getFallbackTarget: () => Promise<{ dex: Dex; poolAddress: string | null } | undefined>,
  ): Promise<string> {
    try {
      const { transaction } = await this.jupiter.prepareSwap(this.connection, keypair, swapParams, {
        maxPriorityFeeLamports: this.maxPriorityFeeLamports,
        priorityLevel: 'high',
        dynamicSlippage: true,
      });
      return await this.broadcastTransaction(transaction, keypair);
    } catch (jupiterErr) {
      const target = await getFallbackTarget();
      const executor = target ? this.dexRegistry?.getExecutor(target.dex) : undefined;
      if (!executor || !target?.poolAddress) throw jupiterErr;

      this.logger.warn(
        { err: jupiterErr, dex: target.dex, poolAddress: target.poolAddress },
        'Jupiter could not route this swap — falling back to the native DEX executor',
      );

      const tx = await executor.buildSwap({
        connection: this.connection,
        signer: keypair,
        ...swapParams,
        poolAddress: target.poolAddress,
      });
      if (!(tx instanceof VersionedTransaction)) {
        throw new Error(`Native ${target.dex} executor returned an unsupported transaction type`);
      }
      const sim = await this.connection.simulateTransaction(tx, { sigVerify: false });
      if (sim.value.err) {
        throw new Error(
          `Native ${target.dex} swap simulation failed: ${JSON.stringify(sim.value.err)}`,
        );
      }
      return await this.broadcastTransaction(tx, keypair);
    }
  }

  /**
   * Never trust a caller-supplied entry price (an auto-buy fires before any swap has
   * happened, so callers can only ever guess) — resolve it for real, from the same
   * DexScreener price source PriceMonitor will use on every later tick, so entry and
   * exit prices are apples-to-apples. Falls back to deriving a price from what was
   * actually spent vs. actually received if DexScreener has nothing yet, and only
   * as an absolute last resort returns 0 — which evaluateExit treats as "unknown,"
   * never as a real price to compute PnL against.
   */
  private async resolveEntryPriceUsd(
    mint: string,
    amountSol: number,
    tokensReceivedRaw: bigint,
  ): Promise<number> {
    try {
      const pair = await this.dexScreener.getBestSolanaPair(mint);
      const price = pair?.priceUsd ? Number(pair.priceUsd) : undefined;
      if (price !== undefined && Number.isFinite(price) && price > 0) return price;
    } catch (err) {
      this.logger.debug(
        { mint, err },
        'dexscreener price lookup failed while resolving entry price',
      );
    }

    try {
      const [solPriceUsd, mintInfo] = await Promise.all([
        this.solPriceOracle.getPriceUsd(this.dexScreener),
        getMint(this.connection, new PublicKey(mint)),
      ]);
      const tokensReceived = Number(tokensReceivedRaw) / 10 ** mintInfo.decimals;
      if (solPriceUsd !== undefined && tokensReceived > 0) {
        return (amountSol * solPriceUsd) / tokensReceived;
      }
    } catch (err) {
      this.logger.debug({ mint, err }, 'fallback entry price derivation failed');
    }

    this.logger.warn(
      { mint },
      'could not resolve a real entry price for this position — recording 0 (treated as unknown, not a real price, so TP/SL cannot fire off it)',
    );
    return 0;
  }

  async openPosition(params: OpenPositionParams) {
    const lockKey = `${params.walletId}:${params.tokenId}`;
    if (this.isLockActive(lockKey)) {
      const reason = `A previous buy for wallet ${params.walletId} / token ${params.tokenId} landed on-chain but could not be verified — refusing to submit another swap until this is manually reconciled (or until the lock auto-expires).`;
      this.logger.warn(
        {
          walletId: params.walletId,
          mint: params.mint,
          tokenId: params.tokenId,
          location: 'apps/api/src/trading/positionManager.ts:openPosition',
        },
        `BUY CANCELLED\nReason:\n${reason}`,
      );
      throw new Error(reason);
    }

    const check = await this.safety.checkBeforeOpen(
      {
        userId: params.userId,
        walletId: params.walletId,
        walletPublicKey: params.walletPublicKey,
        amountSol: params.amountSol,
        tokenId: params.tokenId,
      },
      { isLive: !this.paperTrading },
    );
    if (!check.allowed) {
      const reason = check.reason ?? 'unknown safety violation';
      this.logger.warn(
        {
          reason,
          walletId: params.walletId,
          mint: params.mint,
          location: 'apps/api/src/trading/safety.ts:checkBeforeOpen',
        },
        `BUY CANCELLED\nReason:\n${reason}`,
      );
      throw new SafetyCheckError(reason);
    }
    this.logger.debug(
      { walletId: params.walletId, mint: params.mint, paperTrading: this.paperTrading },
      'Wallet: safety check passed — Buy Executor starting',
    );

    const amountLamports = BigInt(Math.floor(params.amountSol * LAMPORTS_PER_SOL));

    let outAmount: string;
    let signature: string;

    if (this.paperTrading) {
      // Simulated fill: get a real Jupiter quote for realistic sizing, but never touch
      // the wallet's private key or broadcast anything.
      const quote = await this.jupiter.getQuote({
        inputMint: SOL_MINT,
        outputMint: params.mint,
        amountLamports,
        slippageBps: params.slippageBps,
      });
      outAmount = quote.outAmount;
      signature = paperSignature();
    } else {
      const keypair = unsealKeypair(params.encryptedSecret, params.encryptionKey);
      this.logger.debug(
        { walletPublicKey: keypair.publicKey.toBase58(), mint: params.mint },
        'Buy Executor: sending live swap',
      );
      try {
        signature = await this.sendSwap(
          keypair,
          {
            inputMint: SOL_MINT,
            outputMint: params.mint,
            amountLamports,
            slippageBps: params.slippageBps,
          },
          async () => {
            const token = await this.prisma.token.findUnique({ where: { id: params.tokenId } });
            return token ? { dex: token.dex, poolAddress: token.poolAddress } : undefined;
          },
        );
      } catch (err) {
        await this.recordFailedTrade({
          walletId: params.walletId,
          tokenId: params.tokenId,
          side: 'BUY',
          amountSol: params.amountSol,
          slippageBps: params.slippageBps,
          err,
        });
        throw err;
      }

      // The swap itself landed on-chain from here on — any further failure is a
      // verification problem, not a "nothing happened" problem, so this wallet+token
      // is locked out of further auto-buys until a human reconciles it (see
      // unverifiedSwapLocks's doc comment: retrying blind here would submit a
      // second real buy on top of one that already landed).
      this.unverifiedSwapLocks.set(lockKey, Date.now());
      try {
        // The quote is only an estimate — record what actually landed in the wallet,
        // since a later sell has to work with the real balance, not the estimate.
        // Retried: the RPC node frequently hasn't caught up with a just-landed tx yet
        // (see withVerificationRetry's doc comment) — most "verification failures" are
        // this transient lag, not a real problem.
        const actualReceived = await withVerificationRetry(
          () =>
            getActualTokenDelta(
              this.connection,
              signature,
              keypair.publicKey.toBase58(),
              params.mint,
            ),
          3,
          this.verificationRetryDelayMs,
        );
        outAmount = actualReceived.toString();
        this.unverifiedSwapLocks.delete(lockKey);
      } catch (err) {
        const reason = `BUY landed on-chain (signature ${signature}) but could not be verified after retries for wallet ${params.walletId} / token ${params.tokenId}. Position was NOT recorded. Manual reconciliation required — further auto-buys for this wallet+token are blocked for up to ${PositionManager.RECONCILIATION_LOCK_TTL_MS / 60_000} minutes, then automatically recover.`;
        this.logger.error(
          {
            err,
            walletId: params.walletId,
            tokenId: params.tokenId,
            signature,
            location: 'apps/api/src/trading/positionManager.ts:openPosition',
          },
          `BUY CANCELLED\nReason:\n${reason}`,
        );
        await this.recordFailedTrade({
          walletId: params.walletId,
          tokenId: params.tokenId,
          side: 'BUY',
          amountSol: params.amountSol,
          slippageBps: params.slippageBps,
          signature,
          err,
        });
        await this.notifier?.notifyError('openPosition verification', reason);
        throw err;
      }
    }

    const entryPriceUsd = await this.resolveEntryPriceUsd(
      params.mint,
      params.amountSol,
      BigInt(outAmount),
    );

    const trade = await this.prisma.trade.create({
      data: {
        walletId: params.walletId,
        tokenId: params.tokenId,
        side: 'BUY',
        status: 'CONFIRMED',
        amountSol: params.amountSol,
        amountToken: Number(outAmount),
        priceUsd: entryPriceUsd,
        txSignature: signature,
        slippageBps: params.slippageBps,
        isPaperTrade: this.paperTrading,
        confirmedAt: new Date(),
      },
    });

    // Never allow a position to be created with no exit strategy at all — a
    // position with every TP/SL/trailing field null can only ever be closed
    // manually (evaluateExit has nothing to compare against), and no caller in
    // this app currently exposes a manual-close action either. Falls back to
    // defaultExitParams() only when the caller supplied none of the three
    // fields; any explicit configuration (a preset's resolved params, or a
    // user's own manual custom values) is always respected as-is and never
    // overridden here.
    const hasExitStrategy =
      params.takeProfitPercent != null ||
      params.stopLossPercent != null ||
      params.trailingStopPercent != null;
    const fallbackExit = hasExitStrategy ? undefined : defaultExitParams();
    if (fallbackExit) {
      this.logger.warn(
        { walletId: params.walletId, tokenId: params.tokenId, mint: params.mint },
        'openPosition: caller supplied no exit strategy — applying the balanced-preset default so this position is never unclosable',
      );
    }

    const position = await this.prisma.position.create({
      data: {
        walletId: params.walletId,
        tokenId: params.tokenId,
        entryPriceUsd,
        amountToken: Number(outAmount),
        amountSolInvested: params.amountSol,
        highWaterMarkUsd: entryPriceUsd,
        takeProfitPercent: params.takeProfitPercent ?? fallbackExit?.takeProfitPercent,
        stopLossPercent: params.stopLossPercent ?? fallbackExit?.stopLossPercent,
        trailingStopPercent: params.trailingStopPercent ?? fallbackExit?.trailingStopPercent,
        trailingStopPreset: params.trailingStopPreset ?? (fallbackExit ? 'balanced' : undefined),
        isPaperTrade: this.paperTrading,
      },
    });

    this.logger.info(
      {
        tradeId: trade.id,
        positionId: position.id,
        signature,
        walletId: params.walletId,
        mint: params.mint,
      },
      `BUY EXECUTED\nSignature:\n${signature}`,
    );

    eventBus.publish('trade.created', { tradeId: trade.id, side: 'BUY', mint: params.mint });
    eventBus.publish('position.updated', { positionId: position.id, status: 'OPEN' });

    // Notification-only enrichment (DEX name/buy link/trade card) — a single
    // indexed PK lookup, never gates or affects the trade itself, which has already
    // fully executed above.
    const token = await this.prisma.token.findUnique({ where: { id: params.tokenId } });

    this.logger.debug(
      { positionId: position.id, hasNotifier: !!this.notifier },
      'Telegram Notification: dispatching BUY notifyTrade',
    );
    await this.notifier?.notifyTrade({
      side: 'BUY',
      symbol: params.symbol ?? params.mint.slice(0, 8),
      mint: params.mint,
      dex: token?.dex,
      amountSol: params.amountSol,
      priceUsd: entryPriceUsd || undefined,
      signature,
      isPaperTrade: this.paperTrading,
    });

    if (token) {
      // Best-effort fresh momentum for the card — never blocks/risks the trade
      // above, which has already fully executed; a failed lookup just omits it.
      const freshPair = await this.dexScreener
        .getBestSolanaPair(params.mint)
        .catch(() => undefined);
      await this.notifier?.notifyBuyCard({
        token: {
          mint: params.mint,
          name: token.name ?? undefined,
          symbol: token.symbol ?? params.symbol,
          dex: token.dex,
          imageUrl: token.imageUrl ?? undefined,
          marketCapUsd: token.marketCapUsd ?? undefined,
          liquidityUsd: token.liquidityUsd ?? undefined,
          aiScore: params.aiScore ?? token.aiScore ?? undefined,
          holderCount: token.holderCount ?? undefined,
          priceChangeH1: freshPair?.priceChange?.h1,
          isHoneypotSuspected: token.isHoneypotSuspected ?? undefined,
          mintAuthorityRevoked: token.mintAuthorityRevoked ?? undefined,
          freezeAuthorityRevoked: token.freezeAuthorityRevoked ?? undefined,
          lpBurnedOrLocked: token.lpBurnedOrLocked ?? undefined,
          top10HolderPercent: token.top10HolderPercent ?? undefined,
        },
        entryPriceUsd,
        amountSol: params.amountSol,
        estimatedUsdValue:
          entryPriceUsd > 0
            ? entryPriceUsd * (Number(outAmount) / 10 ** token.decimals)
            : undefined,
        walletPublicKey: params.walletPublicKey,
        positionId: position.id,
        signature,
        timestamp: new Date(),
      });
    }

    return { trade, position };
  }

  /** Called on each price tick for every open position; closes it if an exit rule fires. */
  async checkAndMaybeClose(
    positionId: string,
    currentPriceUsd: number,
    encryptedSecret: string,
    encryptionKey: string,
  ) {
    const position = await this.prisma.position.findUniqueOrThrow({
      where: { id: positionId },
      include: { token: true },
    });
    if (position.status !== 'OPEN') return { closed: false as const };

    const decision = evaluateExit({
      entryPriceUsd: position.entryPriceUsd,
      currentPriceUsd,
      highWaterMarkUsd: position.highWaterMarkUsd ?? position.entryPriceUsd,
      takeProfitPercent: position.takeProfitPercent,
      stopLossPercent: position.stopLossPercent,
      trailingStopPercent: position.trailingStopPercent,
    });
    this.logger.debug(
      {
        positionId,
        currentPriceUsd,
        pnlPercent: decision.pnlPercent,
        shouldExit: decision.shouldExit,
        reason: decision.reason,
      },
      'Sell Executor checkpoint: evaluateExit result',
    );

    if (!decision.shouldExit) {
      await this.prisma.position.update({
        where: { id: positionId },
        data: { highWaterMarkUsd: decision.newHighWaterMarkUsd },
      });
      return { closed: false as const };
    }

    return this.closePosition(position.id, position.walletId, encryptedSecret, encryptionKey, {
      currentPriceUsd,
      reason: decision.reason,
    });
  }

  async closePosition(
    positionId: string,
    walletId: string,
    encryptedSecret: string,
    encryptionKey: string,
    exit: { currentPriceUsd: number; reason?: ExitReason },
  ) {
    if (this.isLockActive(positionId)) {
      const reason = `A previous sell for position ${positionId} landed on-chain but could not be verified — refusing to submit another swap until this is manually reconciled (or until the lock auto-expires).`;
      this.logger.warn(
        { positionId, walletId, location: 'apps/api/src/trading/positionManager.ts:closePosition' },
        `SELL CANCELLED\nReason:\n${reason}`,
      );
      throw new Error(reason);
    }

    const position = await this.prisma.position.findUniqueOrThrow({
      where: { id: positionId },
      include: { token: true },
    });

    let outAmountLamports: number;
    let soldAmountToken: number;
    let signature: string;

    if (this.paperTrading) {
      const quote = await this.jupiter.getQuote({
        inputMint: position.token.mint,
        outputMint: SOL_MINT,
        amountLamports: BigInt(Math.floor(position.amountToken)),
        slippageBps: 300,
      });
      outAmountLamports = Number(quote.outAmount);
      soldAmountToken = position.amountToken;
      signature = paperSignature();
    } else {
      const keypair = unsealKeypair(encryptedSecret, encryptionKey);
      // Never sell the stored/estimated amount blindly — it can exceed what's actually
      // in the wallet (e.g. from a quote-vs-actual gap at buy time) and get rejected
      // on-chain. Cap to the real balance, whichever is smaller.
      const realBalance = await getRealTokenBalance(
        this.connection,
        keypair.publicKey.toBase58(),
        position.token.mint,
      );
      const recordedAmount = BigInt(Math.floor(position.amountToken));
      const sellAmountRaw = realBalance < recordedAmount ? realBalance : recordedAmount;
      this.logger.debug(
        {
          walletPublicKey: keypair.publicKey.toBase58(),
          mint: position.token.mint,
          realBalance: realBalance.toString(),
          recordedAmount: recordedAmount.toString(),
          sellAmountRaw: sellAmountRaw.toString(),
        },
        'Sell Executor: sending live swap',
      );

      // Live-verified 2026-07-11: a position recorded OPEN with a real, confirmed
      // buy on file can still have a wallet balance of exactly 0 — the tokens left
      // the wallet through some path this bot never recorded (most plausibly an
      // out-of-band/manual transfer or sale, since the buy tx itself was verified
      // on-chain and no sell ever landed through this codebase). Submitting a sell
      // for 0 tokens isn't a retryable failure — the PumpSwap program rejects a
      // zero-amount swap outright — so every future price tick would repeat this
      // exact failed attempt forever, burning an RPC/simulation call each time with
      // no possible resolution. Reconcile immediately instead: close the position
      // (no realizedPnlUsd — what actually happened to the tokens is unknown, so a
      // number here would just be a guess) and flag it for manual review.
      if (sellAmountRaw <= 0n) {
        this.logger.error(
          {
            positionId,
            walletPublicKey: keypair.publicKey.toBase58(),
            mint: position.token.mint,
            recordedAmount: recordedAmount.toString(),
          },
          'closePosition: wallet holds 0 of this token for a position recorded OPEN — closing for manual reconciliation instead of retrying forever',
        );
        await this.recordFailedTrade({
          walletId,
          tokenId: position.tokenId,
          side: 'SELL',
          amountSol: 0,
          amountToken: 0,
          err: new Error(
            'Wallet balance is 0 for this open position — tokens left the wallet outside this bot; closed for manual reconciliation, no realized PnL recorded',
          ),
        });
        const reconciled = await this.prisma.position.update({
          where: { id: positionId },
          data: { status: 'CLOSED', closedAt: new Date() },
        });
        eventBus.publish('position.updated', { positionId: reconciled.id, status: 'CLOSED' });
        await this.notifier?.notifyError(
          'closePosition zero-balance reconciliation',
          `Position ${positionId} (${position.token.symbol ?? position.token.mint}) was recorded OPEN with ${recordedAmount} tokens on file, but the wallet holds 0. Closed automatically to stop the retry loop — no realized PnL was recorded since the actual disposition of the tokens is unknown. Manual reconciliation required.`,
        );
        return { closed: true as const, position: reconciled, signature: null };
      }

      try {
        signature = await this.sendSwap(
          keypair,
          {
            inputMint: position.token.mint,
            outputMint: SOL_MINT,
            amountLamports: sellAmountRaw,
            slippageBps: 300,
          },
          async () => ({ dex: position.token.dex, poolAddress: position.token.poolAddress }),
        );
      } catch (err) {
        // Position deliberately stays OPEN here — nothing below this point runs,
        // so status/realizedPnlUsd are never touched. The caller (checkAndMaybeClose
        // via priceMonitor, or a manual sell) retries on its own next pass. Safe to
        // retry freely: the swap itself never landed, so nothing real happened yet.
        await this.recordFailedTrade({
          walletId,
          tokenId: position.tokenId,
          side: 'SELL',
          amountSol: 0,
          amountToken: Number(sellAmountRaw),
          err,
        });
        throw err;
      }

      // The swap itself landed on-chain from here on — any further failure is a
      // verification problem, not a "nothing happened" problem. Locking the
      // position out of further auto-sell attempts is what actually matters here:
      // live-verified 2026-07-11, a transient verification-RPC failure at this
      // exact point let PriceMonitor's next tick see the position still OPEN with
      // its original amountToken untouched, and resubmit a fresh sell of the same
      // amount — twice — draining unrelated token balance out of the wallet each
      // time. See unverifiedSwapLocks's doc comment.
      this.unverifiedSwapLocks.set(positionId, Date.now());
      try {
        // Retried for the same reason as the BUY-side verification — see
        // withVerificationRetry's doc comment.
        const actualSolReceived = await withVerificationRetry(
          () => getActualSolDelta(this.connection, signature, keypair.publicKey.toBase58()),
          3,
          this.verificationRetryDelayMs,
        );
        outAmountLamports = Number(actualSolReceived);
        soldAmountToken = Number(sellAmountRaw);
        this.unverifiedSwapLocks.delete(positionId);
      } catch (err) {
        const reason = `SELL landed on-chain (signature ${signature}) but could not be verified after retries for position ${positionId}. Position was left OPEN with stale amountToken. Manual reconciliation required — further auto-sell attempts for this position are blocked for up to ${PositionManager.RECONCILIATION_LOCK_TTL_MS / 60_000} minutes, then automatically recover.`;
        this.logger.error(
          {
            err,
            positionId,
            walletId,
            signature,
            location: 'apps/api/src/trading/positionManager.ts:closePosition',
          },
          `SELL CANCELLED\nReason:\n${reason}`,
        );
        await this.recordFailedTrade({
          walletId,
          tokenId: position.tokenId,
          side: 'SELL',
          amountSol: 0,
          amountToken: Number(sellAmountRaw),
          signature,
          err,
        });
        await this.notifier?.notifyError('closePosition verification', reason);
        throw err;
      }
    }

    // position.amountToken is the RAW on-chain integer amount (e.g. 32678849019 for
    // a 9-decimal token) — must be decimal-adjusted before multiplying by a USD
    // price delta, exactly like computeTrailingStopDisplay's currentProfitUsd does.
    // Live-verified failure: an un-adjusted calc here produced a phantom
    // -$395,414.07 "loss" on a real ~-$0.04 close, which then tripped the daily
    // loss safety limit and blocked every subsequent trade for the rest of the day.
    const realizedPnlUsd =
      (exit.currentPriceUsd - position.entryPriceUsd) *
      (position.amountToken / 10 ** position.token.decimals);

    const sellTrade = await this.prisma.trade.create({
      data: {
        walletId,
        tokenId: position.tokenId,
        side: 'SELL',
        status: 'CONFIRMED',
        amountSol: outAmountLamports / LAMPORTS_PER_SOL,
        amountToken: soldAmountToken,
        priceUsd: exit.currentPriceUsd,
        txSignature: signature,
        isPaperTrade: this.paperTrading,
        confirmedAt: new Date(),
      },
    });

    const updated = await this.prisma.position.update({
      where: { id: positionId },
      data: {
        status: 'CLOSED',
        realizedPnlUsd,
        closedAt: new Date(),
      },
    });

    this.logger.info(
      { positionId, signature, reason: exit.reason, realizedPnlUsd },
      'position closed',
    );

    eventBus.publish('trade.created', {
      tradeId: sellTrade.id,
      side: 'SELL',
      mint: position.token.mint,
    });
    eventBus.publish('position.updated', {
      positionId: updated.id,
      status: 'CLOSED',
      realizedPnlUsd,
    });

    // Sell Signal: fires for every real sell regardless of what triggered it. This is
    // additional to the TP/SL/trailing-specific alert below, not a replacement for
    // it — before this, a manual close (exit.reason undefined) had no alert path at
    // all, since notifyExit only ever fired when a reason was set.
    this.logger.debug(
      { positionId, hasNotifier: !!this.notifier },
      'Telegram Notification: dispatching SELL notifyTrade',
    );
    await this.notifier?.notifyTrade({
      side: 'SELL',
      symbol: position.token.symbol ?? position.token.mint.slice(0, 8),
      mint: position.token.mint,
      dex: position.token.dex,
      amountSol: outAmountLamports / LAMPORTS_PER_SOL,
      priceUsd: exit.currentPriceUsd || undefined,
      signature,
      isPaperTrade: this.paperTrading,
    });

    if (exit.reason) {
      const pnlPercent =
        ((exit.currentPriceUsd - position.entryPriceUsd) / position.entryPriceUsd) * 100;
      const display = computeTrailingStopDisplay({
        entryPriceUsd: position.entryPriceUsd,
        currentPriceUsd: exit.currentPriceUsd,
        highWaterMarkUsd: position.highWaterMarkUsd ?? position.entryPriceUsd,
        amountToken: position.amountToken,
        tokenDecimals: position.token.decimals,
        trailingStopPercent: position.trailingStopPercent,
      });
      await this.notifier?.notifyExit({
        symbol: position.token.symbol ?? position.token.mint.slice(0, 8),
        mint: position.token.mint,
        dex: position.token.dex,
        reason: exit.reason,
        pnlPercent,
        pnlUsd: realizedPnlUsd,
        isPaperTrade: this.paperTrading,
        entryPriceUsd: display.entryPriceUsd,
        athUsd: display.athUsd,
        lockedProfitPercent: display.lockedProfitPercent,
      });
    }

    // The sell already landed and the position is already CLOSED above — everything
    // from here on is purely a notification/share-caption side effect. Wrapped in
    // its own try/catch so a DB hiccup here (e.g. the best-effort buy-trade lookup)
    // can never surface as a "close failed" error for a trade that in fact succeeded.
    try {
      if (this.notifier) {
        // No Trade->Position FK exists (extend-only scope, not a schema
        // rearchitecture) — best-effort match: the most recent BUY trade for this
        // wallet+token. Correct for the common case (one open position per token,
        // matching this app's own MAX_OPEN_POSITIONS usage); ambiguous only if the
        // same wallet held multiple concurrent/rapid positions in the same token.
        const buyTrade = await this.prisma.trade.findFirst({
          where: { walletId, tokenId: position.tokenId, side: 'BUY' },
          orderBy: { createdAt: 'desc' },
        });
        const holdingTimeMs =
          (updated.closedAt ?? new Date()).getTime() - position.createdAt.getTime();
        const pnlPercentForCard =
          ((exit.currentPriceUsd - position.entryPriceUsd) / position.entryPriceUsd) * 100;
        const displayForCard = computeTrailingStopDisplay({
          entryPriceUsd: position.entryPriceUsd,
          currentPriceUsd: exit.currentPriceUsd,
          highWaterMarkUsd: position.highWaterMarkUsd ?? position.entryPriceUsd,
          amountToken: position.amountToken,
          tokenDecimals: position.token.decimals,
          trailingStopPercent: position.trailingStopPercent,
        });
        const cardCaption = await this.notifier.notifySellCard({
          token: {
            mint: position.token.mint,
            name: position.token.name ?? undefined,
            symbol: position.token.symbol ?? undefined,
            dex: position.token.dex,
            imageUrl: position.token.imageUrl ?? undefined,
            marketCapUsd: position.token.marketCapUsd ?? undefined,
            liquidityUsd: position.token.liquidityUsd ?? undefined,
            aiScore: position.token.aiScore ?? undefined,
            holderCount: position.token.holderCount ?? undefined,
            isHoneypotSuspected: position.token.isHoneypotSuspected ?? undefined,
            mintAuthorityRevoked: position.token.mintAuthorityRevoked ?? undefined,
            freezeAuthorityRevoked: position.token.freezeAuthorityRevoked ?? undefined,
            lpBurnedOrLocked: position.token.lpBurnedOrLocked ?? undefined,
            top10HolderPercent: position.token.top10HolderPercent ?? undefined,
          },
          entryPriceUsd: position.entryPriceUsd,
          exitPriceUsd: exit.currentPriceUsd,
          buyAmountSol: position.amountSolInvested,
          sellAmountSol: outAmountLamports / LAMPORTS_PER_SOL,
          profitSol: outAmountLamports / LAMPORTS_PER_SOL - position.amountSolInvested,
          profitUsd: realizedPnlUsd,
          roiPercent:
            position.amountSolInvested > 0
              ? ((outAmountLamports / LAMPORTS_PER_SOL - position.amountSolInvested) /
                  position.amountSolInvested) *
                100
              : 0,
          pnlPercent: pnlPercentForCard,
          holdingTimeMs,
          exitReason: exit.reason ?? 'manual',
          highestProfitPercent: displayForCard.highestProfitPercent,
          lockedProfitPercent: displayForCard.lockedProfitPercent,
          walletPublicKey:
            (
              await this.prisma.wallet.findUnique({
                where: { id: walletId },
                select: { publicKey: true },
              })
            )?.publicKey ?? walletId,
          positionId,
          buySignature: buyTrade?.txSignature ?? '—',
          sellSignature: signature,
        });
        if (cardCaption) {
          await this.prisma.position.update({
            where: { id: positionId },
            data: { shareCaption: cardCaption },
          });
        }
      }
    } catch (err) {
      this.logger.error({ err, positionId }, 'failed to build/send SELL trade card');
    }

    return { closed: true as const, position: updated, signature };
  }
}
