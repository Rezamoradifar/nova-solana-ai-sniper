import type { Api, Bot } from 'grammy';
import type { Logger } from '@nova/shared';

export interface TradeNotification {
  side: 'BUY' | 'SELL';
  symbol: string;
  mint: string;
  amountSol: number;
  priceUsd?: number;
  signature: string;
  isPaperTrade?: boolean;
}

export interface PositionExitNotification {
  symbol: string;
  reason: 'take_profit' | 'stop_loss' | 'trailing_stop';
  pnlPercent: number;
  pnlUsd?: number;
  isPaperTrade?: boolean;
}

export interface NewTokenNotification {
  mint: string;
  dex: string;
  liquidityUsd?: number;
  isHoneypotSuspected?: boolean;
  aiScore?: number;
}

export interface MigrationNotification {
  mint: string;
  symbol?: string;
  fromDex: string;
  toDex: string;
}

/**
 * Pure so sendNewTokenAlertToUsers (per-user fan-out) can send the exact same
 * text NotificationService.notifyNewToken sends to the broadcast chat — one
 * source of truth for what a "launch alert" looks like.
 */
export function formatNewTokenMessage(token: NewTokenNotification): string {
  const riskEmoji = token.isHoneypotSuspected ? '🚨' : '🆕';
  const liquidityLine =
    token.liquidityUsd !== undefined ? `\nLiquidity: $${token.liquidityUsd.toFixed(0)}` : '';
  const scoreLine = token.aiScore !== undefined ? `\nScore: ${token.aiScore.toFixed(0)}/100` : '';
  const honeypotLine = token.isHoneypotSuspected ? '\n⚠️ Honeypot/rug risk flagged' : '';
  return (
    `${riskEmoji} *New ${token.dex} launch*\n` +
    `\`${token.mint}\`${liquidityLine}${scoreLine}${honeypotLine}\n` +
    `[Chart](https://dexscreener.com/solana/${token.mint})`
  );
}

/**
 * Pushes trade/position/error alerts to the configured broadcast chat. Every
 * method swallows its own send errors (logged, not thrown) so a Telegram
 * outage never takes down the caller (worker/API request path).
 */
export class NotificationService {
  constructor(
    private readonly bot: Bot,
    private readonly chatId: string,
    private readonly logger: Logger,
  ) {}

  private async send(text: string): Promise<void> {
    try {
      await this.bot.api.sendMessage(this.chatId, text, { parse_mode: 'Markdown' });
    } catch (err) {
      this.logger.error({ err }, 'failed to send telegram notification');
    }
  }

  async notifyTrade(trade: TradeNotification): Promise<void> {
    const emoji = trade.side === 'BUY' ? '🟢' : '🔴';
    const paperTag = trade.isPaperTrade ? ' 📝 PAPER' : '';
    const priceLine = trade.priceUsd ? `\nPrice: $${trade.priceUsd.toFixed(6)}` : '';
    const txLine = trade.isPaperTrade
      ? '\n_(simulated fill, no on-chain tx)_'
      : `\n[Tx](https://solscan.io/tx/${trade.signature})`;
    await this.send(
      `${emoji} *${trade.side}*${paperTag} \`${trade.symbol}\`\n` +
        `Amount: ${trade.amountSol} SOL${priceLine}${txLine}`,
    );
  }

  async notifyExit(exit: PositionExitNotification): Promise<void> {
    const emoji = exit.pnlPercent >= 0 ? '✅' : '⚠️';
    const paperTag = exit.isPaperTrade ? ' 📝 PAPER' : '';
    const reasonLabel = exit.reason.replace(/_/g, ' ');
    await this.send(
      `${emoji}${paperTag} Position closed: \`${exit.symbol}\`\n` +
        `Reason: ${reasonLabel}\n` +
        `PnL: ${exit.pnlPercent.toFixed(2)}%`,
    );
  }

  async notifyError(context: string, message: string): Promise<void> {
    await this.send(`🚨 *Error* in ${context}\n${message}`);
  }

  async notifySocialMention(text: string, tweetId: string): Promise<void> {
    await this.send(
      `🐦 *X mention*\n${text.slice(0, 300)}\n` + `[View](https://x.com/i/web/status/${tweetId})`,
    );
  }

  async notifyNewToken(token: NewTokenNotification): Promise<void> {
    await this.send(formatNewTokenMessage(token));
  }

  async notifyMigration(migration: MigrationNotification): Promise<void> {
    const label = migration.symbol ?? migration.mint.slice(0, 8);
    await this.send(
      `🚀 *Migration detected*: \`${label}\`\n` +
        `${migration.fromDex} → ${migration.toDex}\n` +
        `[Chart](https://dexscreener.com/solana/${migration.mint})`,
    );
  }
}

/**
 * Standalone (not part of NotificationService, which is bound to one fixed
 * broadcast chat) because this sends to an arbitrary referrer's own chat —
 * fired once, the moment maybeActivateReferralReward actually activates them.
 * Swallows its own send error (logged, not thrown), same convention as
 * NotificationService, so a Telegram outage never breaks the referral flow itself.
 */
export async function sendReferralRewardNotification(
  api: Api,
  chatId: string,
  referredCount: number,
  logger: Logger,
): Promise<void> {
  try {
    await api.sendMessage(
      chatId,
      `🎉 *Referral reward unlocked!*\n\n` +
        `You've referred ${referredCount} people — a default auto-buy sniper config is now active for you.\n` +
        `Check ▶️ Start Sniper to review or adjust it.`,
      { parse_mode: 'Markdown' },
    );
  } catch (err) {
    logger.error({ err }, 'failed to send referral reward telegram notification');
  }
}

/**
 * Personal counterpart to NotificationService.notifyNewToken's single broadcast
 * chat: fans the identical alert text out to every user whose own SnipeConfig is
 * live (isActive + autoBuyOnLaunch), so e.g. a referral-reward-activated user sees
 * the same launch alerts the ops broadcast chat sees, not just their eventual auto-buy
 * with no warning it happened. Best-effort per recipient — one blocked/broken chat
 * (bot blocked, deleted account) never stops the rest, and never blocks or throws
 * back into the launch-detection pipeline that calls this.
 */
export async function sendNewTokenAlertToUsers(
  api: Api,
  chatIds: string[],
  token: NewTokenNotification,
  logger: Logger,
): Promise<void> {
  if (chatIds.length === 0) return;
  const text = formatNewTokenMessage(token);
  const results = await Promise.allSettled(
    chatIds.map((chatId) => api.sendMessage(chatId, text, { parse_mode: 'Markdown' })),
  );
  results.forEach((result, i) => {
    if (result.status === 'rejected') {
      logger.error(
        { err: result.reason, chatId: chatIds[i] },
        'failed to send per-user new-token alert',
      );
    }
  });
}
