import { randomBytes } from 'node:crypto';
import { Connection, PublicKey } from '@solana/web3.js';
import type { PrismaClient } from '@prisma/client';
import { unsealKeypair, type Logger } from '@nova/shared';
import type { NotificationService } from '@nova/telegram-bot';
import { JupiterClient, SOL_MINT } from '../solana/jupiter.js';
import { evaluateExit, type ExitReason } from './exitEngine.js';
import { eventBus } from '../lib/eventBus.js';
import { TradingSafety, SafetyCheckError } from './safety.js';

const LAMPORTS_PER_SOL = 1_000_000_000;

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
  entryPriceUsd: number;
  takeProfitPercent?: number;
  stopLossPercent?: number;
  trailingStopPercent?: number;
}

/** A random-looking signature so paper trades are visually distinct from real (base58) ones. */
function paperSignature(): string {
  return `PAPER${randomBytes(16).toString('hex')}`;
}

export class PositionManager {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly connection: Connection,
    private readonly jupiter: JupiterClient,
    private readonly logger: Logger,
    private readonly safety: TradingSafety,
    private readonly notifier?: NotificationService,
    /** Real swaps only ever execute when this is explicitly false (LIVE_TRADING=true). */
    private readonly paperTrading: boolean = true,
  ) {}

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
      const { transaction } = await this.jupiter.prepareSwap(this.connection, keypair, {
        inputMint: SOL_MINT,
        outputMint: params.mint,
        amountLamports,
        slippageBps: params.slippageBps,
      });
      signature = await this.connection.sendTransaction(transaction);
      await this.connection.confirmTransaction(signature, 'confirmed');
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

    const trade = await this.prisma.trade.create({
      data: {
        walletId: params.walletId,
        tokenId: params.tokenId,
        side: 'BUY',
        status: 'CONFIRMED',
        amountSol: params.amountSol,
        amountToken: Number(outAmount),
        priceUsd: params.entryPriceUsd,
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
        entryPriceUsd: params.entryPriceUsd,
        amountToken: Number(outAmount),
        amountSolInvested: params.amountSol,
        highWaterMarkUsd: params.entryPriceUsd,
        takeProfitPercent: params.takeProfitPercent,
        stopLossPercent: params.stopLossPercent,
        trailingStopPercent: params.trailingStopPercent,
        isPaperTrade: this.paperTrading,
      },
    });

    this.logger.info({ tradeId: trade.id, positionId: position.id, signature }, 'position opened');

    eventBus.publish('trade.created', { tradeId: trade.id, side: 'BUY', mint: params.mint });
    eventBus.publish('position.updated', { positionId: position.id, status: 'OPEN' });

    await this.notifier?.notifyTrade({
      side: 'BUY',
      symbol: params.symbol ?? params.mint.slice(0, 8),
      mint: params.mint,
      amountSol: params.amountSol,
      priceUsd: params.entryPriceUsd || undefined,
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

      const { transaction } = await this.jupiter.prepareSwap(this.connection, keypair, {
        inputMint: position.token.mint,
        outputMint: SOL_MINT,
        amountLamports: sellAmountRaw,
        slippageBps: 300,
      });
      signature = await this.connection.sendTransaction(transaction);
      await this.connection.confirmTransaction(signature, 'confirmed');
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

    if (exit.reason) {
      const pnlPercent =
        ((exit.currentPriceUsd - position.entryPriceUsd) / position.entryPriceUsd) * 100;
      await this.notifier?.notifyExit({
        symbol: position.token.symbol ?? position.token.mint.slice(0, 8),
        reason: exit.reason,
        pnlPercent,
        pnlUsd: realizedPnlUsd,
        isPaperTrade: this.paperTrading,
      });
    }

    return { closed: true as const, position: updated, signature };
  }
}
