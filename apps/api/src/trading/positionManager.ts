import type { Connection } from '@solana/web3.js';
import type { PrismaClient } from '@prisma/client';
import type { Logger } from '@nova/shared';
import { JupiterClient, SOL_MINT } from '../solana/jupiter.js';
import { unsealKeypair } from '../security/keystore.js';
import { evaluateExit } from './exitEngine.js';

const LAMPORTS_PER_SOL = 1_000_000_000;

export interface OpenPositionParams {
  walletId: string;
  encryptedSecret: string;
  encryptionKey: string;
  tokenId: string;
  mint: string;
  amountSol: number;
  slippageBps: number;
  entryPriceUsd: number;
  takeProfitPercent?: number;
  stopLossPercent?: number;
  trailingStopPercent?: number;
}

export class PositionManager {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly connection: Connection,
    private readonly jupiter: JupiterClient,
    private readonly logger: Logger,
  ) {}

  async openPosition(params: OpenPositionParams) {
    const keypair = unsealKeypair(params.encryptedSecret, params.encryptionKey);
    const amountLamports = BigInt(Math.floor(params.amountSol * LAMPORTS_PER_SOL));

    const { quote, transaction } = await this.jupiter.prepareSwap(this.connection, keypair, {
      inputMint: SOL_MINT,
      outputMint: params.mint,
      amountLamports,
      slippageBps: params.slippageBps,
    });

    const signature = await this.connection.sendTransaction(transaction);
    await this.connection.confirmTransaction(signature, 'confirmed');

    const trade = await this.prisma.trade.create({
      data: {
        walletId: params.walletId,
        tokenId: params.tokenId,
        side: 'BUY',
        status: 'CONFIRMED',
        amountSol: params.amountSol,
        amountToken: Number(quote.outAmount),
        priceUsd: params.entryPriceUsd,
        txSignature: signature,
        slippageBps: params.slippageBps,
        confirmedAt: new Date(),
      },
    });

    const position = await this.prisma.position.create({
      data: {
        walletId: params.walletId,
        tokenId: params.tokenId,
        entryPriceUsd: params.entryPriceUsd,
        amountToken: Number(quote.outAmount),
        amountSolInvested: params.amountSol,
        highWaterMarkUsd: params.entryPriceUsd,
        takeProfitPercent: params.takeProfitPercent,
        stopLossPercent: params.stopLossPercent,
        trailingStopPercent: params.trailingStopPercent,
      },
    });

    this.logger.info({ tradeId: trade.id, positionId: position.id, signature }, 'position opened');
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
    exit: { currentPriceUsd: number; reason?: string },
  ) {
    const position = await this.prisma.position.findUniqueOrThrow({
      where: { id: positionId },
      include: { token: true },
    });

    const keypair = unsealKeypair(encryptedSecret, encryptionKey);

    const { quote, transaction } = await this.jupiter.prepareSwap(this.connection, keypair, {
      inputMint: position.token.mint,
      outputMint: SOL_MINT,
      amountLamports: BigInt(Math.floor(position.amountToken)),
      slippageBps: 300,
    });

    const signature = await this.connection.sendTransaction(transaction);
    await this.connection.confirmTransaction(signature, 'confirmed');

    const realizedPnlUsd = (exit.currentPriceUsd - position.entryPriceUsd) * position.amountToken;

    await this.prisma.trade.create({
      data: {
        walletId,
        tokenId: position.tokenId,
        side: 'SELL',
        status: 'CONFIRMED',
        amountSol: Number(quote.outAmount) / LAMPORTS_PER_SOL,
        amountToken: position.amountToken,
        priceUsd: exit.currentPriceUsd,
        txSignature: signature,
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

    return { closed: true as const, position: updated, signature };
  }
}
