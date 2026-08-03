import { describe, expect, it, vi } from 'vitest';
import { checkMintBlacklist } from './mintBlacklist.js';

describe('checkMintBlacklist', () => {
  it('reports not blacklisted when no matching row exists', async () => {
    const prisma = { blacklistEntry: { findUnique: vi.fn().mockResolvedValue(null) } } as never;
    const result = await checkMintBlacklist(prisma, 'MintABC');
    expect(result).toEqual({ blacklisted: false });
  });

  it('reports blacklisted with the stored reason when a matching row exists', async () => {
    const prisma = {
      blacklistEntry: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'bl-1',
          type: 'MINT',
          value: 'MintABC',
          reason: 'USOH incident — bundled wallet cluster',
        }),
      },
    } as never;
    const result = await checkMintBlacklist(prisma, 'MintABC');
    expect(result).toEqual({ blacklisted: true, reason: 'USOH incident — bundled wallet cluster' });
  });

  it('always queries by exact type=MINT + value=mint — never matches a DEPLOYER-type row for the same value', async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    const prisma = { blacklistEntry: { findUnique } } as never;
    await checkMintBlacklist(prisma, 'MintABC');
    expect(findUnique).toHaveBeenCalledWith({
      where: { type_value: { type: 'MINT', value: 'MintABC' } },
    });
  });

  it('reports blacklisted=true even when the stored reason is null', async () => {
    const prisma = {
      blacklistEntry: {
        findUnique: vi
          .fn()
          .mockResolvedValue({ id: 'bl-1', type: 'MINT', value: 'MintABC', reason: null }),
      },
    } as never;
    const result = await checkMintBlacklist(prisma, 'MintABC');
    expect(result.blacklisted).toBe(true);
    expect(result.reason).toBeUndefined();
  });
});
