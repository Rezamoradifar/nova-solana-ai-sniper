import type { PrismaClient } from '@prisma/client';
import { isValidSolanaPublicKey } from './env.js';
import { getOrCreateBusinessSettings, type BusinessSettingsWithLevels } from './fee.js';

/**
 * Admin writes to BusinessSettings, shared by the bot's /admin panel and the
 * Mini App's admin API so both enforce the same rules. Each returns an error
 * message for the admin, or undefined on success, and writes an AuditLog row.
 */

/** Who made the change, recorded in the audit log. */
export type AdminActor = { telegramId?: string | number; userId?: string };

function pct(bps: number): string {
  return `${Number((bps / 100).toFixed(2))}%`;
}

/** Parses "20", "20%", "12,5" into basis points; undefined if not a 0-100 number. */
export function parsePercentToBps(text: string): number | undefined {
  const n = Number(text.trim().replace(/%$/, '').replace(',', '.'));
  if (!Number.isFinite(n) || n < 0 || n > 100) return undefined;
  return Math.round(n * 100);
}

/**
 * Referral levels are paid out of the platform fee, so the enabled levels
 * together may never exceed it.
 */
export function checkFeeBudget(
  settings: Pick<BusinessSettingsWithLevels, 'performanceFeeBps' | 'referralLevels'>,
  change: { feeBps?: number; level?: number; levelBps?: number },
): string | undefined {
  const feeBps = change.feeBps ?? settings.performanceFeeBps;
  const levels = new Map<number, number>();
  for (const l of settings.referralLevels) levels.set(l.level, l.enabled ? l.percentBps : 0);
  if (change.level !== undefined && change.levelBps !== undefined) {
    levels.set(change.level, change.levelBps);
  }
  const referralTotal = [...levels.values()].reduce((a, b) => a + b, 0);
  if (referralTotal > feeBps) {
    return `Referral levels total ${pct(referralTotal)}, which is more than the platform fee ${pct(feeBps)}. Referral rewards are paid out of the fee — raise the fee or lower a level first.`;
  }
  return undefined;
}

async function audit(
  prisma: PrismaClient,
  action: string,
  actor: AdminActor,
  metadata: Record<string, unknown>,
): Promise<void> {
  await prisma.auditLog.create({
    data: {
      action,
      userId: actor.userId,
      metadata: { adminTelegramId: actor.telegramId?.toString(), ...metadata },
    },
  });
}

export async function setTreasuryWallet(
  prisma: PrismaClient,
  actor: AdminActor,
  address: string,
): Promise<string | undefined> {
  const trimmed = address.trim();
  if (!isValidSolanaPublicKey(trimmed)) return 'That is not a valid Solana wallet address.';
  const settings = await getOrCreateBusinessSettings(prisma);
  await prisma.businessSettings.update({
    where: { id: settings.id },
    data: { treasuryWalletAddress: trimmed },
  });
  await audit(prisma, 'admin.set_treasury_wallet', actor, {
    old: settings.treasuryWalletAddress,
    new: trimmed,
  });
  return undefined;
}

export async function setPlatformFee(
  prisma: PrismaClient,
  actor: AdminActor,
  feeBps: number,
): Promise<string | undefined> {
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 10_000) {
    return 'The fee must be between 0% and 100%.';
  }
  const settings = await getOrCreateBusinessSettings(prisma);
  const budgetError = checkFeeBudget(settings, { feeBps });
  if (budgetError) return budgetError;
  await prisma.businessSettings.update({
    where: { id: settings.id },
    data: { performanceFeeBps: feeBps },
  });
  await audit(prisma, 'admin.set_performance_fee', actor, {
    oldBps: settings.performanceFeeBps,
    newBps: feeBps,
  });
  return undefined;
}

export async function setReferralLevel(
  prisma: PrismaClient,
  actor: AdminActor,
  level: number,
  percentBps: number,
): Promise<string | undefined> {
  if (!Number.isInteger(level) || level < 1) return 'Referral level must be 1 or higher.';
  if (!Number.isInteger(percentBps) || percentBps < 0 || percentBps > 10_000) {
    return 'The referral percent must be between 0% and 100%.';
  }
  const settings = await getOrCreateBusinessSettings(prisma);
  const budgetError = checkFeeBudget(settings, { level, levelBps: percentBps });
  if (budgetError) return budgetError;
  await prisma.referralLevelConfig.upsert({
    where: { businessSettingsId_level: { businessSettingsId: settings.id, level } },
    create: { businessSettingsId: settings.id, level, percentBps, enabled: true },
    update: { percentBps, enabled: true },
  });
  await audit(prisma, 'admin.set_referral_level', actor, { level, percentBps });
  return undefined;
}

export async function setReferralProgramEnabled(
  prisma: PrismaClient,
  actor: AdminActor,
  enabled: boolean,
): Promise<void> {
  const settings = await getOrCreateBusinessSettings(prisma);
  await prisma.businessSettings.update({
    where: { id: settings.id },
    data: { referralProgramEnabled: enabled },
  });
  await audit(prisma, 'admin.toggle_referral_program', actor, { enabled });
}
