import { InputFile, type Bot, type Context } from 'grammy';
import { walletBackupSchema } from '@nova/shared';
import { LABEL_TO_SCREEN, mainMenuKeyboard } from './keyboards.js';
import { resolveOrCreateUser } from './user.js';
import { getPending, setPending, clearPending } from './pending.js';
import type { ScreenDeps, ScreenId, ScreenResult, ScreenUser } from './types.js';

import { renderHome } from './screens/home.js';
import {
  renderSniperStart,
  renderSniperStop,
  handleQuickStart,
  handleResumeAll,
  handleStopAll,
} from './screens/sniper.js';
import {
  renderWallet,
  handleCreateWallet,
  handleDeactivateWallet,
  importPrompt,
  applyImportWallet,
  backupPasswordPrompt,
  applyBackup,
  restoreFilePrompt,
  restorePasswordPrompt,
  applyRestore,
} from './screens/wallet.js';
import { renderDashboard } from './screens/dashboard.js';
import {
  renderPositions,
  takeProfitPrompt,
  stopLossPrompt,
  applyTakeProfit,
  applyStopLoss,
} from './screens/positions.js';
import { renderTrades } from './screens/trades.js';
import { renderLeaderboard } from './screens/leaderboard.js';
import { renderAlerts } from './screens/alerts.js';
import {
  renderSettings,
  promptFor,
  applySettingsEdit,
  isSettingsField,
} from './screens/settings.js';
import { renderProfile } from './screens/profile.js';
import { renderPortfolio } from './screens/portfolio.js';
import { renderReferrals } from './screens/referrals.js';
import { renderHelp } from './screens/help.js';

async function renderScreen(
  screen: ScreenId,
  deps: ScreenDeps,
  user: ScreenUser,
  ctx: Context,
): Promise<ScreenResult> {
  switch (screen) {
    case 'home':
      return renderHome(deps, user);
    case 'sniper_start':
      return renderSniperStart(deps, user);
    case 'sniper_stop':
      return renderSniperStop(deps, user);
    case 'wallet':
      return renderWallet(deps, user);
    case 'dashboard':
      return renderDashboard(deps, user);
    case 'positions':
      return renderPositions(deps, user);
    case 'trades':
      return renderTrades(deps, user);
    case 'leaderboard':
      return renderLeaderboard(deps, user);
    case 'alerts':
      return renderAlerts(deps, user);
    case 'settings':
      return renderSettings(deps, user);
    case 'profile':
      return renderProfile(deps, user, ctx);
    case 'portfolio':
      return renderPortfolio(deps, user);
    case 'referrals':
      return renderReferrals(deps, user, ctx);
    case 'help':
      return renderHelp(deps, user);
  }
}

/** Runs a button action, returning the screen to show afterwards (or nothing if it only prompted for text input). */
async function handleAction(
  data: string,
  deps: ScreenDeps,
  user: ScreenUser,
  ctx: Context,
): Promise<ScreenResult | undefined> {
  const chatId = ctx.chat!.id;
  const [screen, action, ...rest] = data.slice(2).split(':');

  switch (`${screen}:${action}`) {
    case 'sniper:quickstart':
      return handleQuickStart(deps, user);
    case 'sniper:resumeall':
      return handleResumeAll(deps, user);
    case 'sniper:stopall':
      return handleStopAll(deps, user);

    case 'wallet:create':
      return handleCreateWallet(deps, user, ctx);
    case 'wallet:import':
      setPending(chatId, { type: 'wallet_import', returnTo: 'wallet' });
      return importPrompt();
    case 'wallet:deactivate':
      return handleDeactivateWallet(deps, user, rest[0]!);
    case 'wallet:backup':
      setPending(chatId, {
        type: 'wallet_backup_awaiting_password',
        walletId: rest[0]!,
        returnTo: 'wallet',
      });
      return backupPasswordPrompt();
    case 'wallet:restore':
      setPending(chatId, { type: 'wallet_restore_awaiting_file', returnTo: 'wallet' });
      return restoreFilePrompt();

    case 'positions:edittp':
      setPending(chatId, { type: 'position_edit_tp', positionId: rest[0]!, returnTo: 'positions' });
      return takeProfitPrompt();
    case 'positions:editsl':
      setPending(chatId, { type: 'position_edit_sl', positionId: rest[0]!, returnTo: 'positions' });
      return stopLossPrompt();

    case 'settings:edit': {
      const [field, snipeConfigId] = rest;
      if (typeof field !== 'string' || !isSettingsField(field) || !snipeConfigId) return undefined;
      setPending(chatId, { type: 'settings_edit', snipeConfigId, field, returnTo: 'settings' });
      return promptFor(field);
    }

    case 'referrals:refresh':
      return renderReferrals(deps, user, ctx);

    default:
      return undefined;
  }
}

export function registerUiRouter(bot: Bot, deps: ScreenDeps): void {
  bot.command('start', async (ctx) => sendWelcomeAndHome(ctx, deps));

  // Consumes pending text-input flows (wallet import, TP/SL edits, settings edits)
  // before anything else gets a chance to interpret the message.
  bot.on('message:text', async (ctx, next) => {
    const pendingAction = getPending(ctx.chat.id);
    if (!pendingAction) return next();

    const user = await resolveOrCreateUser(deps.prisma, ctx);
    const text = ctx.message.text;
    const send = async (result: ScreenResult) =>
      ctx.reply(result.text, { parse_mode: 'Markdown', reply_markup: result.keyboard });

    switch (pendingAction.type) {
      case 'wallet_import': {
        const outcome = await applyImportWallet(deps, user, text);
        if (!outcome.ok) return void (await ctx.reply(outcome.message));
        clearPending(ctx.chat.id);
        return void (await send(outcome.result));
      }
      case 'position_edit_tp': {
        const outcome = await applyTakeProfit(deps, user, pendingAction.positionId, text);
        if (!outcome.ok) return void (await ctx.reply(outcome.message));
        clearPending(ctx.chat.id);
        return void (await send(outcome.result));
      }
      case 'position_edit_sl': {
        const outcome = await applyStopLoss(deps, user, pendingAction.positionId, text);
        if (!outcome.ok) return void (await ctx.reply(outcome.message));
        clearPending(ctx.chat.id);
        return void (await send(outcome.result));
      }
      case 'settings_edit': {
        const outcome = await applySettingsEdit(
          deps,
          user,
          pendingAction.snipeConfigId,
          pendingAction.field,
          text,
        );
        if (!outcome.ok) return void (await ctx.reply(outcome.message));
        clearPending(ctx.chat.id);
        return void (await send(outcome.result));
      }
      case 'wallet_backup_awaiting_password': {
        const outcome = await applyBackup(deps, user, pendingAction.walletId, text);
        if (!outcome.ok) return void (await ctx.reply(outcome.message));
        clearPending(ctx.chat.id);
        await ctx.replyWithDocument(new InputFile(outcome.buffer, outcome.filename), {
          caption: '💾 Encrypted wallet backup — store this file and its password somewhere safe.',
        });
        return;
      }
      case 'wallet_restore_awaiting_file':
        return void (await ctx.reply(
          'Send the backup file as a Telegram document (attach the .json file), not as text.',
        ));
      case 'wallet_restore_awaiting_password': {
        const outcome = await applyRestore(deps, user, pendingAction.backup, text);
        if (!outcome.ok) return void (await ctx.reply(outcome.message));
        clearPending(ctx.chat.id);
        return void (await send(outcome.result));
      }
    }
  });

  // The file-upload half of Restore Wallet — only fires while that flow is pending.
  bot.on('message:document', async (ctx, next) => {
    const pendingAction = getPending(ctx.chat.id);
    if (pendingAction?.type !== 'wallet_restore_awaiting_file') return next();

    try {
      const file = await ctx.getFile();
      const res = await fetch(`https://api.telegram.org/file/bot${bot.token}/${file.file_path}`);
      const json = JSON.parse(await res.text());
      const parsed = walletBackupSchema.safeParse(json);
      if (!parsed.success) {
        await ctx.reply(
          "⚠️ That doesn't look like a valid Nova wallet backup file. Send the correct file, or ⬅️ Back to cancel.",
        );
        return;
      }
      setPending(ctx.chat.id, {
        type: 'wallet_restore_awaiting_password',
        backup: parsed.data,
        returnTo: 'wallet',
      });
      const prompt = restorePasswordPrompt();
      await ctx.reply(prompt.text, { parse_mode: 'Markdown', reply_markup: prompt.keyboard });
    } catch (err) {
      deps.logger.error({ err }, 'wallet restore file handling failed');
      await ctx.reply('⚠️ Could not read that file. Try again, or ⬅️ Back to cancel.');
    }
  });

  // Reply-keyboard (bottom menu) button taps — each sends a fresh message with an inline keyboard.
  bot.on('message:text').hears(Object.keys(LABEL_TO_SCREEN), async (ctx) => {
    const screen = LABEL_TO_SCREEN[ctx.message.text];
    if (!screen) return;
    clearPending(ctx.chat.id);
    try {
      const user = await resolveOrCreateUser(deps.prisma, ctx);
      const result = await renderScreen(screen, deps, user, ctx);
      await ctx.reply(result.text, { parse_mode: 'Markdown', reply_markup: result.keyboard });
    } catch (err) {
      deps.logger.error({ err, screen }, 'telegram ui menu tap failed');
      await ctx.reply('⚠️ Something went wrong rendering that screen.').catch(() => {});
    }
  });

  // Inline button taps — screen navigation (`s:*`) and actions (`a:*`), editing the message in place.
  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;
    try {
      const user = await resolveOrCreateUser(deps.prisma, ctx);
      let result: ScreenResult | undefined;

      if (data.startsWith('s:')) {
        clearPending(ctx.chat!.id);
        result = await renderScreen(data.slice(2) as ScreenId, deps, user, ctx);
      } else if (data.startsWith('a:')) {
        result = await handleAction(data, deps, user, ctx);
      }

      if (result) {
        await ctx.editMessageText(result.text, {
          parse_mode: 'Markdown',
          reply_markup: result.keyboard,
        });
      }
      await ctx.answerCallbackQuery();
    } catch (err) {
      // Re-tapping a button that would produce identical content (e.g. Refresh with
      // nothing new) isn't a real failure — Telegram just rejects the no-op edit.
      const description = (err as { description?: string }).description ?? '';
      if (description.includes('message is not modified')) {
        await ctx.answerCallbackQuery().catch(() => {});
        return;
      }
      deps.logger.error({ err, data }, 'telegram ui callback failed');
      await ctx
        .answerCallbackQuery({ text: '⚠️ Something went wrong.', show_alert: true })
        .catch(() => {});
    }
  });
}

/** Sends the welcome message (reply keyboard) followed by the Home screen. */
export async function sendWelcomeAndHome(ctx: Context, deps: ScreenDeps): Promise<void> {
  const user = await resolveOrCreateUser(
    deps.prisma,
    ctx,
    ctx.match ? String(ctx.match) : undefined,
  );
  await ctx.reply('👋 *Nova Solana AI Sniper* is ready. Use the menu below to navigate.', {
    parse_mode: 'Markdown',
    reply_markup: mainMenuKeyboard(),
  });
  const result = await renderHome(deps, user);
  await ctx.reply(result.text, { parse_mode: 'Markdown', reply_markup: result.keyboard });
}
