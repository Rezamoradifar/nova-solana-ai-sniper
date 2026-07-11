import type { Api, Bot } from 'grammy';
import type { PrismaClient } from '@prisma/client';
import type { Logger } from '@nova/shared';

export interface TradeNotification {
  side: 'BUY' | 'SELL';
  symbol: string;
  mint: string;
  dex?: string;
  amountSol: number;
  priceUsd?: number;
  signature: string;
  isPaperTrade?: boolean;
}

export interface PositionExitNotification {
  symbol: string;
  mint?: string;
  dex?: string;
  reason: 'take_profit' | 'stop_loss' | 'trailing_stop';
  pnlPercent: number;
  pnlUsd?: number;
  isPaperTrade?: boolean;
}

export interface NewTokenNotification {
  mint: string;
  dex: string;
  name?: string;
  symbol?: string;
  liquidityUsd?: number;
  marketCapUsd?: number;
  aiScore?: number;
  isHoneypotSuspected?: boolean;
  mintAuthorityRevoked?: boolean;
  freezeAuthorityRevoked?: boolean;
  lpBurnedOrLocked?: boolean;
  top10HolderPercent?: number;
}

export interface MigrationNotification {
  mint: string;
  symbol?: string;
  fromDex: string;
  toDex: string;
}

/** `https://dexscreener.com/solana/{mint}` — the one chart-link format used everywhere. */
export function buildDexScreenerLink(mint: string): string {
  return `https://dexscreener.com/solana/${mint}`;
}

/**
 * DEX-aware "buy this token" link. pump.fun/PumpSwap both live under pump.fun's own
 * UI (PumpSwap is pump.fun's own post-migration AMM). Every other DEX — including
 * any future integration this codebase doesn't know about by name yet — falls back
 * to Jupiter's aggregator swap link, which can route through any Solana DEX, so a
 * new DEX integration never needs a corresponding change here to get a working link.
 */
export function buildBuyLink(dex: string, mint: string): string {
  const normalized = dex.toUpperCase();
  if (normalized === 'PUMPFUN' || normalized === 'PUMPSWAP') {
    return `https://pump.fun/coin/${mint}`;
  }
  return `https://jup.ag/swap/SOL-${mint}`;
}

function linksLine(mint: string, dex?: string): string {
  const chart = `[Chart](${buildDexScreenerLink(mint)})`;
  return dex ? `${chart} · [Buy](${buildBuyLink(dex, mint)})` : chart;
}

/**
 * Pure so both NotificationService.notifyNewToken and its regression tests can
 * assert on exactly what a "New Launch" alert looks like — one source of truth.
 */
export function formatNewTokenMessage(token: NewTokenNotification): string {
  const riskEmoji = token.isHoneypotSuspected ? '🚨' : '🆕';
  const nameLine =
    token.name || token.symbol
      ? `\n${token.name ?? ''}${token.name && token.symbol ? ' — ' : ''}${token.symbol ? `$${token.symbol}` : ''}`
      : '';
  const liquidityLine =
    token.liquidityUsd !== undefined ? `\nLiquidity: $${token.liquidityUsd.toFixed(0)}` : '';
  const marketCapLine =
    token.marketCapUsd !== undefined ? `\nMarket Cap: $${token.marketCapUsd.toFixed(0)}` : '';
  const scoreLine =
    token.aiScore !== undefined ? `\nAI Score: ${token.aiScore.toFixed(0)}/100` : '';
  const riskParts: string[] = [];
  if (token.mintAuthorityRevoked !== undefined) {
    riskParts.push(`Mint ${token.mintAuthorityRevoked ? '✅' : '⚠️'}`);
  }
  if (token.freezeAuthorityRevoked !== undefined) {
    riskParts.push(`Freeze ${token.freezeAuthorityRevoked ? '✅' : '⚠️'}`);
  }
  if (token.lpBurnedOrLocked !== undefined) {
    riskParts.push(`LP ${token.lpBurnedOrLocked ? '🔒' : '⚠️'}`);
  }
  if (token.top10HolderPercent !== undefined) {
    riskParts.push(`Top10 ${token.top10HolderPercent.toFixed(0)}%`);
  }
  const riskLine = riskParts.length > 0 ? `\nRisk: ${riskParts.join(' | ')}` : '';
  const honeypotLine = token.isHoneypotSuspected ? '\n⚠️ Honeypot/rug risk flagged' : '';
  return (
    `${riskEmoji} *New ${token.dex} launch*${nameLine}\n` +
    `\`${token.mint}\`${liquidityLine}${marketCapLine}${scoreLine}${riskLine}${honeypotLine}\n` +
    linksLine(token.mint, token.dex)
  );
}

function formatTradeMessage(trade: TradeNotification): string {
  const emoji = trade.side === 'BUY' ? '🟢' : '🔴';
  const paperTag = trade.isPaperTrade ? ' 📝 PAPER' : '';
  const priceLine = trade.priceUsd ? `\nPrice: $${trade.priceUsd.toFixed(6)}` : '';
  const txLine = trade.isPaperTrade
    ? '\n_(simulated fill, no on-chain tx)_'
    : `\n[Tx](https://solscan.io/tx/${trade.signature})`;
  const linkLine = `\n${linksLine(trade.mint, trade.dex)}`;
  return (
    `${emoji} *${trade.side}*${paperTag} \`${trade.symbol}\`\n` +
    `Amount: ${trade.amountSol} SOL${priceLine}${txLine}${linkLine}`
  );
}

function formatExitMessage(exit: PositionExitNotification): string {
  const emoji = exit.pnlPercent >= 0 ? '✅' : '⚠️';
  const paperTag = exit.isPaperTrade ? ' 📝 PAPER' : '';
  const reasonLabel = exit.reason.replace(/_/g, ' ');
  const linkLine = exit.mint ? `\n${linksLine(exit.mint, exit.dex)}` : '';
  return (
    `${emoji}${paperTag} Position closed: \`${exit.symbol}\`\n` +
    `Reason: ${reasonLabel}\n` +
    `PnL: ${exit.pnlPercent.toFixed(2)}%${linkLine}`
  );
}

/**
 * All Telegram alert delivery goes through this one class — the owner's configured
 * broadcast chat, plus (for the sniper alert types: trade/exit/new-token) every
 * other user whose own SnipeConfig is currently live, so a referral-reward-activated
 * user sees exactly the same alerts as the owner, not a lesser or absent feed.
 * notifyError/notifySocialMention/notifyMigration stay owner-only — they're
 * operational/ops signals, not one of the requested sniper alert types, and nobody
 * asked to have system errors or Twitter mentions pushed to every active user.
 * Every send is best-effort per recipient (logged, not thrown) so one blocked chat,
 * or a Telegram outage entirely, never breaks the caller (worker/API request path).
 */
export class NotificationService {
  constructor(
    private readonly bot: Bot,
    private readonly ownerChatId: string,
    private readonly prisma: PrismaClient,
    private readonly logger: Logger,
  ) {}

  /**
   * The owner chat plus every user with telegramId set and a live SnipeConfig
   * (isActive + autoBuyOnLaunch — the exact same set AutoTrader.evaluateAndMaybeBuy
   * queries, so "receives alerts" and "sniper is active" never drift apart).
   * De-duplicated via Set, so an owner who is also an active user (or two active
   * SnipeConfig rows for the same person) never gets the same alert twice.
   */
  private async activeRecipientChatIds(): Promise<string[]> {
    const activeUsers = await this.prisma.user.findMany({
      where: {
        telegramId: { not: null },
        snipeConfigs: { some: { isActive: true, autoBuyOnLaunch: true } },
      },
      select: { telegramId: true },
    });
    return [...new Set([this.ownerChatId, ...activeUsers.map((u) => u.telegramId!)])];
  }

  private async sendToChat(chatId: string, text: string): Promise<void> {
    try {
      await this.bot.api.sendMessage(chatId, text, { parse_mode: 'Markdown' });
    } catch (err) {
      this.logger.error({ err, chatId }, 'failed to send telegram notification');
    }
  }

  /** Owner-only — used by the ops/operational notifications, not the sniper alert types. */
  private async sendToOwner(text: string): Promise<void> {
    await this.sendToChat(this.ownerChatId, text);
  }

  /** Fans out to the owner + every currently-active user, identical text to each. */
  private async sendToActiveUsers(text: string): Promise<void> {
    const chatIds = await this.activeRecipientChatIds();
    await Promise.all(chatIds.map((chatId) => this.sendToChat(chatId, text)));
  }

  async notifyTrade(trade: TradeNotification): Promise<void> {
    await this.sendToActiveUsers(formatTradeMessage(trade));
  }

  async notifyExit(exit: PositionExitNotification): Promise<void> {
    await this.sendToActiveUsers(formatExitMessage(exit));
  }

  async notifyNewToken(token: NewTokenNotification): Promise<void> {
    await this.sendToActiveUsers(formatNewTokenMessage(token));
  }

  async notifyError(context: string, message: string): Promise<void> {
    await this.sendToOwner(`🚨 *Error* in ${context}\n${message}`);
  }

  async notifySocialMention(text: string, tweetId: string): Promise<void> {
    await this.sendToOwner(
      `🐦 *X mention*\n${text.slice(0, 300)}\n` + `[View](https://x.com/i/web/status/${tweetId})`,
    );
  }

  async notifyMigration(migration: MigrationNotification): Promise<void> {
    const label = migration.symbol ?? migration.mint.slice(0, 8);
    await this.sendToOwner(
      `🚀 *Migration detected*: \`${label}\`\n` +
        `${migration.fromDex} → ${migration.toDex}\n` +
        `[Chart](${buildDexScreenerLink(migration.mint)})`,
    );
  }
}

/**
 * Standalone (distinct from NotificationService's sniper-alert pipeline above) — this
 * sends a one-time congratulatory DM to an arbitrary referrer's own chat, fired once,
 * the moment maybeActivateReferralReward actually activates them. Not a recurring DEX
 * alert type, so it isn't part of the unified alert pipeline. Swallows its own send
 * error (logged, not thrown), same convention as NotificationService.
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
