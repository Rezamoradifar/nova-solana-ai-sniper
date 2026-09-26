import { InlineKeyboard, type Bot, type Context, type NextFunction } from 'grammy';
import type { PrismaClient } from '@prisma/client';
import {
  getOrCreateBusinessSettings,
  parsePercentToBps,
  setPlatformFee,
  setReferralLevel,
  setReferralProgramEnabled,
  setTreasuryWallet,
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
      await setReferralProgramEnabled(prisma, { telegramId: ctx.from?.id }, enabled);
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
  const actor = { telegramId: adminId };
  let error: string | undefined;
  if (field === 'treasury') {
    error = await setTreasuryWallet(prisma, actor, text);
  } else {
    const bps = parsePercentToBps(text);
    if (bps === undefined) return 'Send a number between 0 and 100.';
    error =
      field === 'fee'
        ? await setPlatformFee(prisma, actor, bps)
        : await setReferralLevel(prisma, actor, field === 'level1' ? 1 : 2, bps);
  }
  if (!error) logger.warn({ adminId, field, value: text }, 'admin changed a business setting');
  return error;
}
