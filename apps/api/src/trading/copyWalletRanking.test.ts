import { describe, expect, it, vi } from 'vitest';
import { rankCopyWallet, loadRankedCopyWallets } from './copyWalletRanking.js';

const now = Date.UTC(2026, 9, 9);
const rows = () =>
  Array.from({ length: 20 }, (_, i) => ({
    mint: `token-${i % 5}`,
    entryAt: new Date(now - 3600_000 - i * 1000),
    exitAt: new Date(now - 1800_000 - i * 1000),
    exitSignature: `exit-${i}`,
    status: 'EXITED',
    realizedPnlSol: i % 4 === 0 ? -0.1 : 0.2,
    isRugOrScam: false,
  }));

describe('copy wallet recommendations', () => {
  it('qualifies a diverse, recent, profitable verified sample', () => {
    const result = rankCopyWallet(rows(), 0, now);
    expect(result.eligible).toBe(true);
    expect(result.closedTrades).toBe(20);
    expect(result.realizedPnlSol).toBeCloseTo(2.5);
    expect(result.profitFactor).toBeCloseTo(6);
  });
  it('does not count unrealized, expired or unsigned outcomes as verified closes', () => {
    expect(
      rankCopyWallet(
        rows().map((r) => ({ ...r, status: 'EXPIRED' })),
        0,
        now,
      ).closedTrades,
    ).toBe(0);
    expect(
      rankCopyWallet(
        rows().map((r) => ({ ...r, exitSignature: null })),
        0,
        now,
      ).eligible,
    ).toBe(false);
  });
  it('discloses missing Sybil evidence and rejects elevated known risk', () => {
    expect(rankCopyWallet(rows(), null, now).warnings).toContain(
      'Sybil assessment unavailable; review wallet before enabling',
    );
    expect(rankCopyWallet(rows(), 80, now).eligible).toBe(false);
  });
  it('rejects small samples, single-token luck and outlier-driven profits', () => {
    expect(rankCopyWallet(rows().slice(0, 19), 0, now).eligible).toBe(false);
    expect(
      rankCopyWallet(
        rows().map((r) => ({ ...r, mint: 'same' })),
        0,
        now,
      ).eligible,
    ).toBe(false);
    const outlier = rows();
    outlier[0]!.realizedPnlSol = 100;
    expect(rankCopyWallet(outlier, 0, now).eligible).toBe(false);
  });
  it('does not count one exit more than once', () => {
    expect(
      rankCopyWallet(
        rows().map((r) => ({ ...r, exitSignature: 'same-exit' })),
        0,
        now,
      ).closedTrades,
    ).toBe(0);
  });
  it('rejects stale, too-fast, losing, or invalid observations', () => {
    expect(rankCopyWallet(rows(), 0, now + 4 * 86_400_000).eligible).toBe(false);
    expect(
      rankCopyWallet(
        rows().map((r) => ({ ...r, exitAt: new Date(r.entryAt.getTime() + 1000) })),
        0,
        now,
      ).eligible,
    ).toBe(false);
    expect(
      rankCopyWallet(
        rows().map((r) => ({ ...r, realizedPnlSol: -0.1 })),
        0,
        now,
      ).eligible,
    ).toBe(false);
    expect(
      rankCopyWallet(
        rows().map((r) => ({ ...r, realizedPnlSol: NaN })),
        0,
        now,
      ).closedTrades,
    ).toBe(0);
  });
  it('excludes internal wallets and refuses a truncated history', async () => {
    const wallets = [
      { address: 'internal', sybilConfidencePct: 0, entries: rows() },
      {
        address: 'external',
        sybilConfidencePct: 0,
        entries: Array.from({ length: 501 }, (_, i) => rows()[i % 20]!),
      },
    ];
    const result = await loadRankedCopyWallets(
      {
        smartWalletTokenEntry: {
          groupBy: async () => wallets.map((wallet) => ({ walletAddress: wallet.address })),
        },
        smartWallet: { findMany: async () => wallets },
        wallet: { findMany: async () => [{ publicKey: 'internal' }] },
      } as never,
      now,
    );
    expect(result.map((w) => w.address)).toEqual(['external']);
    expect(result[0]!.recommendation.eligible).toBe(false);
    expect(result[0]!.recommendation.reasons).toContain(
      'History exceeds the bounded review sample',
    );
  });

  it('selects the 100-wallet candidate set by recent entry counts', async () => {
    const groupBy = vi
      .fn()
      .mockResolvedValue([{ walletAddress: 'recent', _count: { walletAddress: 30 } }]);
    const findMany = vi
      .fn()
      .mockResolvedValue([{ address: 'recent', sybilConfidencePct: 0, entries: rows() }]);
    await loadRankedCopyWallets(
      {
        smartWalletTokenEntry: { groupBy },
        smartWallet: { findMany },
        wallet: { findMany: async () => [] },
      } as never,
      now,
    );
    // The groupBy query itself constrains the same 30-day window and caps the
    // sorted recent-activity sample before wallet observations are materialized.
    expect(groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        by: ['walletAddress'],
        where: expect.objectContaining({
          entryAt: expect.objectContaining({ gte: expect.any(Date), lte: new Date(now) }),
        }),
        orderBy: [{ _count: { walletAddress: 'desc' } }, { walletAddress: 'asc' }],
        take: 100,
      }),
    );
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { isTracked: true, address: { in: ['recent'] } } }),
    );
  });
});
