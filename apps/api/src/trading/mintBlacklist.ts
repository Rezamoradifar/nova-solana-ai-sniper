import type { PrismaClient } from '@prisma/client';

/**
 * Blacklist consistency fix (2026-07-23, USOH incident follow-up): before
 * this, the MINT blacklist was only ever checked inline in worker.ts's
 * handleTelegramSignal — candidatePipeline.ts (the single mandatory gate
 * every on-chain-detected candidate goes through) only checked the DEPLOYER
 * blacklist. A MINT entry added during incident response would have blocked
 * re-processing via Telegram but NOT via on-chain detection. This is the one
 * shared function both paths now call, so a MINT blacklist entry behaves
 * identically regardless of discovery source.
 */
export interface MintBlacklistCheckResult {
  blacklisted: boolean;
  reason?: string;
}

export async function checkMintBlacklist(
  prisma: Pick<PrismaClient, 'blacklistEntry'>,
  mint: string,
): Promise<MintBlacklistCheckResult> {
  const entry = await prisma.blacklistEntry.findUnique({
    where: { type_value: { type: 'MINT', value: mint } },
  });
  return entry ? { blacklisted: true, reason: entry.reason ?? undefined } : { blacklisted: false };
}
