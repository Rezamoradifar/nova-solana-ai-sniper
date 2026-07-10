import type { PrismaClient } from '@prisma/client';

export interface PortfolioSummary {
  walletId: string;
  openPositions: number;
  totalInvestedSol: number;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
}

export class PortfolioService {
  constructor(private readonly prisma: PrismaClient) {}

  async getSummary(walletId: string, livePrices: Map<string, number>): Promise<PortfolioSummary> {
    const positions = await this.prisma.position.findMany({
      where: { walletId },
      include: { token: true },
    });

    const open = positions.filter((p) => p.status === 'OPEN');
    const closed = positions.filter((p) => p.status === 'CLOSED');

    const totalInvestedSol = open.reduce((sum, p) => sum + p.amountSolInvested, 0);
    const realizedPnlUsd = closed.reduce((sum, p) => sum + (p.realizedPnlUsd ?? 0), 0);

    const unrealizedPnlUsd = open.reduce((sum, p) => {
      const currentPrice = livePrices.get(p.token.mint) ?? p.entryPriceUsd;
      const pnl = (currentPrice - p.entryPriceUsd) * p.amountToken;
      return sum + pnl;
    }, 0);

    return {
      walletId,
      openPositions: open.length,
      totalInvestedSol,
      realizedPnlUsd,
      unrealizedPnlUsd,
    };
  }

  async getLeaderboard(limit = 20) {
    const wallets = await this.prisma.wallet.findMany({
      include: {
        positions: { where: { status: 'CLOSED' } },
      },
    });

    return wallets
      .map((w) => ({
        walletId: w.id,
        publicKey: w.publicKey,
        label: w.label,
        realizedPnlUsd: w.positions.reduce((sum, p) => sum + (p.realizedPnlUsd ?? 0), 0),
        closedTrades: w.positions.length,
      }))
      .sort((a, b) => b.realizedPnlUsd - a.realizedPnlUsd)
      .slice(0, limit);
  }
}
