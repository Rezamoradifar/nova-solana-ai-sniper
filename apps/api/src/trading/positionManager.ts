import { randomBytes } from 'node:crypto';
import bs58 from 'bs58';
import { Connection, Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { getMint } from '@solana/spl-token';
import type { Dex, PrismaClient } from '@prisma/client';
import { unsealKeypair, type Logger } from '@nova/shared';
import type { NotificationService } from '@nova/telegram-bot';
import { JupiterClient, SOL_MINT } from '../solana/jupiter.js';
import type { DexScreenerClient } from '../solana/dexscreener.js';
import { SolPriceOracle } from '../solana/pumpfunBondingCurve.js';
import type { DexRegistry } from '../solana/dex/registry.js';
import { JitoClient } from '../solana/jito.js';
import { evaluateExit, type ExitReason } from './exitEngine.js';
import { computeTrailingStopDisplay } from './adaptiveTrailingStop.js';
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
}

/** A random-looking signature so paper trades are visually distinct from real (base58) ones. */
function paperSignature(): string {
  return `PAPER${randomBytes(16).toString('hex')}`;
}

export class PositionManager {
  private readonly solPriceOracle = new SolPriceOracle();

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
        await this.connection.confirmTransaction(signature, 'confirmed');
        return signature;
      } catch (err) {
        this.logger.warn({ err }, 'Jito bundle submission failed — falling back to a direct send');
      }
    }

    await this.connection.sendTransaction(transaction);
    await this.connection.confirmTransaction(signature, 'confirmed');
    return signature;
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
    const check = await this.safety.checkBeforeOpen(
      {
        userId: params.userId,
        walletId: params.walletId,
        walletPublicKey: params.walletPublicKey,
        amountSol: params.amountSol,
      },
      { isLive: !this.paperTrading },
    );
    if (!check.allowed) {
      this.logger.warn(
        { reason: check.reason, walletId: params.walletId, mint: params.mint },
        'trade blocked by safety check',
      );
      throw new SafetyCheckError(check.reason ?? 'unknown safety violation');
    }

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
      // The quote is only an estimate — record what actually landed in the wallet,
      // since a later sell has to work with the real balance, not the estimate.
      const actualReceived = await getActualTokenDelta(
        this.connection,
        signature,
        keypair.publicKey.toBase58(),
        params.mint,
      );
      outAmount = actualReceived.toString();
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

    const position = await this.prisma.position.create({
      data: {
        walletId: params.walletId,
        tokenId: params.tokenId,
        entryPriceUsd,
        amountToken: Number(outAmount),
        amountSolInvested: params.amountSol,
        highWaterMarkUsd: entryPriceUsd,
        takeProfitPercent: params.takeProfitPercent,
        stopLossPercent: params.stopLossPercent,
        trailingStopPercent: params.trailingStopPercent,
        trailingStopPreset: params.trailingStopPreset,
        isPaperTrade: this.paperTrading,
      },
    });

    this.logger.info({ tradeId: trade.id, positionId: position.id, signature }, 'position opened');

    eventBus.publish('trade.created', { tradeId: trade.id, side: 'BUY', mint: params.mint });
    eventBus.publish('position.updated', { positionId: position.id, status: 'OPEN' });

    // dex is notification-only enrichment (for the DEX name + buy link) — a single
    // indexed PK lookup, never gates or affects the trade itself, which has already
    // fully executed above.
    const token = await this.prisma.token.findUnique({
      where: { id: params.tokenId },
      select: { dex: true },
    });

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
      const actualSolReceived = await getActualSolDelta(
        this.connection,
        signature,
        keypair.publicKey.toBase58(),
      );
      outAmountLamports = Number(actualSolReceived);
      soldAmountToken = Number(sellAmountRaw);
    }

    const realizedPnlUsd = (exit.currentPriceUsd - position.entryPriceUsd) * position.amountToken;

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

    return { closed: true as const, position: updated, signature };
  }
}
