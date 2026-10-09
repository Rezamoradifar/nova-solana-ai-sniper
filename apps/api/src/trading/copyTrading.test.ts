import { describe, expect, it, vi, beforeEach } from 'vitest';
import { CopyTradingService, copyBudgetDay } from './copyTrading.js';
import { getUserPlanLimits } from '../lib/plans.js';
vi.mock('../lib/plans.js', () => ({ getUserPlanLimits: vi.fn() }));
const mockedPlan = vi.mocked(getUserPlanLimits);
beforeEach(() =>
  mockedPlan.mockResolvedValue({
    key: 'free',
    feeBps: null,
    maxBuySol: null,
    maxOpenPositions: null,
    autoBuyEnabled: true,
  }),
);
function fixture() {
  const config = {
    id: 'config',
    userId: 'user',
    targetAddress: 'target',
    copyPercentSize: 25,
    maxAmountSol: null,
    user: {
      isSuspended: false,
      deletedAt: null,
      wallets: [{ id: 'wallet', publicKey: 'mine', encryptedSecret: 'encrypted' }],
    },
  };
  const prisma = {
    copyTradeConfig: {
      findMany: vi.fn().mockResolvedValue([config]),
      findFirst: vi.fn().mockResolvedValue(config),
    },
    position: { count: vi.fn().mockResolvedValue(0) },
  };
  const redis = { set: vi.fn().mockResolvedValue('OK'), eval: vi.fn().mockResolvedValue(1) };
  const manager = { openPosition: vi.fn().mockResolvedValue({}) };
  const validateToken = vi.fn().mockResolvedValue(true);
  const signal = {
    targetAddress: 'target',
    mint: 'mint',
    tokenId: 'token',
    amountSolOriginal: 10,
    entryPriceUsd: 1,
    observedAt: Date.now(),
  };
  const service = new CopyTradingService(
    prisma as never,
    manager as never,
    { warn: vi.fn(), error: vi.fn() } as never,
    'not-a-real-key',
    {
      redis: redis as never,
      validateToken,
      maxAmountSol: 0.1,
      maxDailyBuys: 10,
      maxOpenPositions: 3,
      slippageBps: 150,
      maxSignalAgeMs: 120_000,
    },
  );
  return { service, signal, config, prisma, redis, manager, validateToken };
}
describe('bounded copy execution', () => {
  it('caps legacy uncapped configurations and uses bounded slippage', async () => {
    const f = fixture();
    await f.service.mirror(f.signal);
    expect(f.manager.openPosition).toHaveBeenCalledWith(
      expect.objectContaining({ amountSol: 0.1, slippageBps: 150 }),
    );
    expect(f.redis.eval.mock.calls[0]![2]).toContain('copy-trade:daily:user:');
  });
  it('respects the tighter subscription cap', async () => {
    mockedPlan.mockResolvedValue({
      key: 'pro',
      feeBps: 1000,
      maxBuySol: 0.02,
      maxOpenPositions: 2,
      autoBuyEnabled: true,
    });
    const f = fixture();
    await f.service.mirror(f.signal);
    expect(f.manager.openPosition).toHaveBeenCalledWith(
      expect.objectContaining({ amountSol: 0.02 }),
    );
  });
  it('rejects failed token validation before any execution', async () => {
    const f = fixture();
    f.validateToken.mockResolvedValue(false);
    await f.service.mirror(f.signal);
    expect(f.manager.openPosition).not.toHaveBeenCalled();
    expect(f.redis.eval).not.toHaveBeenCalled();
  });
  it('checks suspension and a config paused during the poll', async () => {
    const f = fixture();
    f.config.user.isSuspended = true;
    await f.service.mirror(f.signal);
    expect(f.manager.openPosition).not.toHaveBeenCalled();
    f.config.user.isSuspended = false;
    f.prisma.copyTradeConfig.findFirst.mockResolvedValue(null);
    await f.service.mirror(f.signal);
    expect(f.manager.openPosition).not.toHaveBeenCalled();
  });
  it('rejects account position limits, disabled plans and expired signals', async () => {
    const f = fixture();
    f.prisma.position.count.mockResolvedValue(3);
    await f.service.mirror(f.signal);
    expect(f.manager.openPosition).not.toHaveBeenCalled();
    f.prisma.position.count.mockResolvedValue(0);
    mockedPlan.mockResolvedValue({
      key: 'free',
      feeBps: null,
      maxBuySol: null,
      maxOpenPositions: null,
      autoBuyEnabled: false,
    });
    await f.service.mirror(f.signal);
    expect(f.manager.openPosition).not.toHaveBeenCalled();
    const old = fixture();
    old.signal.observedAt -= 121_000;
    await old.service.mirror(old.signal);
    expect(old.validateToken).not.toHaveBeenCalled();
  });
  it('deduplicates legacy configs belonging to the same user', async () => {
    const f = fixture();
    f.prisma.copyTradeConfig.findMany.mockResolvedValue([
      f.config,
      { ...f.config, id: 'duplicate' },
    ]);
    await f.service.mirror(f.signal);
    expect(f.manager.openPosition).toHaveBeenCalledTimes(1);
  });
  it('fails closed when daily budget is exhausted or Redis fails', async () => {
    const f = fixture();
    f.redis.eval.mockResolvedValue(0);
    await f.service.mirror(f.signal);
    expect(f.manager.openPosition).not.toHaveBeenCalled();
    f.redis.eval.mockRejectedValue(new Error('redis unavailable'));
    await f.service.mirror(f.signal);
    expect(f.manager.openPosition).not.toHaveBeenCalled();
  });
  it('does not reserve/spend while another worker holds the user lock', async () => {
    const f = fixture();
    f.redis.set.mockResolvedValue(null);
    await f.service.mirror(f.signal);
    expect(f.redis.eval).not.toHaveBeenCalled();
    expect(f.manager.openPosition).not.toHaveBeenCalled();
  });
  it('separates daily budgets at Tehran midnight', () => {
    expect(copyBudgetDay(Date.parse('2026-10-09T20:29:59Z'))).toBe('2026-10-09');
    expect(copyBudgetDay(Date.parse('2026-10-09T20:30:00Z'))).toBe('2026-10-10');
  });
});
