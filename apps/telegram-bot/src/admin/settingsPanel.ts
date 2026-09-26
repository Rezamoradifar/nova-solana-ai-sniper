import { InlineKeyboard, type Bot, type Context, type NextFunction } from 'grammy';
import type { PrismaClient } from '@prisma/client';
import {
  getOrCreateBusinessSettings,
  isValidSolanaPublicKey,
  type BusinessSettingsWithLevels,
  type Logger,
} from '@nova/shared';

export type PanelField = 'treasury' | 'fee' | 'level1' | 'level2';

const EDIT_TTL_MS = 5 * 60_000;
const pendingEdits = new Map<number, { field: PanelField; expiresAt: number }>();

function pct(bps: number): string {
  return `${Number((bps / 100).toFixed(2))}%`;
}

function levelBps(settings: BusinessSettingsWithLevels, level: number): number {
  const cfg = settings.referralLevels.find((l) => l.level === level);
  return cfg && cfg.enabled ? cfg.percentBps : 0;
}

/** Parses "20", "20%", "12.5" into basis points; undefined if not a 0-100 number. */
export function parsePercentToBps(text: string): number | undefined {
  const n = Number(text.trim().replace(/%$/, '').replace(',', '.'));
  if (!Number.isFinite(n) || n < 0 || n > 100) return undefined;
  return Math.round(n * 100);
}

/**
 * Referral levels are paid out of the platform fee, so the enabled levels
 * together may never exceed it. Returns an error message, or undefined if OK.
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

export function renderPanel(
  settings: BusinessSettingsWithLevels,
  envTreasury: string | undefined,
): { text: string; keyboard: InlineKeyboard } {
  const treasury = settings.treasuryWalletAddress ?? envTreasury;
  const source = settings.treasuryWalletAddress ? 'set in this panel' : 'from server .env';
  const l1 = levelBps(settings, 1);
  const l2 = levelBps(settings, 2);
  const platformKeeps = Math.max(0, settings.performanceFeeBps - l1 - l2);
  const text =
    `⚙️ *Admin Panel — Fees & Treasury*\n\n` +
    `💼 *Treasury wallet* (${source})\n\`${treasury ?? 'not set'}\`\n\n` +
    `💸 *Platform fee:* ${pct(settings.performanceFeeBps)} of each profitable trade's net profit\n` +
    `👤 User keeps: ${pct(10_000 - settings.performanceFeeBps)}\n\n` +
    `🔗 *Referral program:* ${settings.referralProgramEnabled ? 'ON' : 'OFF'}\n` +
    `Level 1: ${pct(l1)} of net profit\n` +
    `Level 2: ${pct(l2)} of net profit\n` +
    `(paid from the platform fee; the platform keeps at least ${pct(platformKeeps)})\n\n` +
    `Fees are only taken on profitable trades, never on losses.`;
  const keyboard = new InlineKeyboard()
    .text('💼 Treasury wallet', 'adm:edit:treasury')
    .row()
    .text('💸 Platform fee %', 'adm:edit:fee')
    .row()
    .text('🔗 Level 1 %', 'adm:edit:level1')
    .text('🔗 Level 2 %', 'adm:edit:level2')
    .row()
    .text(
      settings.referralProgramEnabled ? '⏸ Turn referrals OFF' : '▶️ Turn referrals ON',
      'adm:toggle',
    )
    .text('🔄 Refresh', 'adm:refresh');
  return { text, keyboard };
}

const PROMPTS: Record<PanelField, string> = {
  treasury:
    '💼 Send the new treasury wallet address (Solana public key).\nThe platform share of every fee will be paid there.',
  fee: '💸 Send the new platform fee as a percent of net profit (e.g. 20).',
  level1: '🔗 Send the Level 1 referral percent of net profit (e.g. 10). Send 0 to disable.',
  level2: '🔗 Send the Level 2 referral percent of net profit (e.g. 5). Send 0 to disable.',
};

export function registerSettingsPanel(
  bot: Bot,
  prisma: PrismaClient,
  admin: (ctx: Context, next: NextFunction) => Promise<void>,
  logger: Logger,
  envTreasury: string | undefined,
): void {
  const showPanel = async (ctx: Context, edit: boolean) => {
    const settings = await getOrCreateBusinessSettings(prisma);
    const { text, keyboard } = renderPanel(settings, envTreasury);
    if (edit) {
      await ctx
        .editMessageText(text, { parse_mode: 'Markdown', reply_markup: keyboard })
        .catch(() => ctx.reply(text, { parse_mode: 'Markdown', reply_markup: keyboard }));
    } else {
      await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: keyboard });
    }
  };

  bot.command('admin', admin, async (ctx) => {
    pendingEdits.delete(ctx.chat.id);
    await showPanel(ctx, false);
  });

  bot.callbackQuery(/^adm:/, admin, async (ctx) => {
    const data = ctx.callbackQuery.data;
    const chatId = ctx.chat?.id;
    await ctx.answerCallbackQuery();
    if (chatId === undefined) return;

    if (data === 'adm:refresh') {
      pendingEdits.delete(chatId);
      await showPanel(ctx, true);
      return;
    }
    if (data === 'adm:toggle') {
      pendingEdits.delete(chatId);
      const settings = await getOrCreateBusinessSettings(prisma);
      const enabled = !settings.referralProgramEnabled;
      await prisma.businessSettings.update({
        where: { id: settings.id },
        data: { referralProgramEnabled: enabled },
      });
      await prisma.auditLog.create({
        data: {
          action: 'admin.toggle_referral_program',
          metadata: { adminId: ctx.from?.id, enabled },
        },
      });
      logger.warn({ adminId: ctx.from?.id, enabled }, 'admin toggled the referral program');
      await showPanel(ctx, true);
      return;
    }
    const field = data.slice('adm:edit:'.length) as PanelField;
    if (!(field in PROMPTS)) return;
    pendingEdits.set(chatId, { field, expiresAt: Date.now() + EDIT_TTL_MS });
    await ctx.reply(`${PROMPTS[field]}\n\nSend /cancel to stop.`);
  });

  bot.on('message:text', async (ctx, next) => {
    const pending = pendingEdits.get(ctx.chat.id);
    if (!pending) return next();
    if (pending.expiresAt < Date.now()) {
      pendingEdits.delete(ctx.chat.id);
      return next();
    }
    const text = ctx.message.text.trim();
    if (text.startsWith('/')) {
      pendingEdits.delete(ctx.chat.id);
      if (text === '/cancel') {
        await ctx.reply('Cancelled.');
        return;
      }
      return next();
    }
    // Only admins can ever have a pending edit, but re-check before writing.
    return admin(ctx, async () => {
      const error = await applyEdit(prisma, logger, ctx.from?.id, pending.field, text);
      if (error) {
        await ctx.reply(`❌ ${error}\n\nTry again, or send /cancel.`);
        return;
      }
      pendingEdits.delete(ctx.chat.id);
      await ctx.reply(
        pending.field === 'fee'
          ? '✅ Saved. Users will be asked to accept the new fee before auto-trading again.'
          : '✅ Saved.',
      );
      await showPanel(ctx, false);
    });
  });
}

/** Validates and saves one panel edit. Returns an error message, or undefined on success. */
export async function applyEdit(
  prisma: PrismaClient,
  logger: Logger,
  adminId: number | undefined,
  field: PanelField,
  text: string,
): Promise<string | undefined> {
  const settings = await getOrCreateBusinessSettings(prisma);

  if (field === 'treasury') {
    if (!isValidSolanaPublicKey(text)) return 'That is not a valid Solana wallet address.';
    await prisma.businessSettings.update({
      where: { id: settings.id },
      data: { treasuryWalletAddress: text },
    });
    await prisma.auditLog.create({
      data: {
        action: 'admin.set_treasury_wallet',
        metadata: { adminId, old: settings.treasuryWalletAddress, new: text },
      },
    });
    logger.warn({ adminId, treasury: text }, 'admin changed the treasury wallet');
    return undefined;
  }

  const bps = parsePercentToBps(text);
  if (bps === undefined) return 'Send a number between 0 and 100.';

  if (field === 'fee') {
    const budgetError = checkFeeBudget(settings, { feeBps: bps });
    if (budgetError) return budgetError;
    await prisma.businessSettings.update({
      where: { id: settings.id },
      data: { performanceFeeBps: bps },
    });
    await prisma.auditLog.create({
      data: {
        action: 'admin.set_performance_fee',
        metadata: { adminId, oldBps: settings.performanceFeeBps, newBps: bps },
      },
    });
    logger.warn({ adminId, feeBps: bps }, 'admin changed the performance fee');
    return undefined;
  }

  const level = field === 'level1' ? 1 : 2;
  const budgetError = checkFeeBudget(settings, { level, levelBps: bps });
  if (budgetError) return budgetError;
  await prisma.referralLevelConfig.upsert({
    where: { businessSettingsId_level: { businessSettingsId: settings.id, level } },
    create: { businessSettingsId: settings.id, level, percentBps: bps, enabled: true },
    update: { percentBps: bps, enabled: true },
  });
  await prisma.auditLog.create({
    data: { action: 'admin.set_referral_level', metadata: { adminId, level, percentBps: bps } },
  });
  logger.warn({ adminId, level, percentBps: bps }, 'admin changed a referral level percentage');
  return undefined;
}
