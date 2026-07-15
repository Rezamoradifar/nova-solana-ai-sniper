import { InputFile, type Api, type Bot, type InlineKeyboard } from 'grammy';
import type { PrismaClient } from '@prisma/client';
import type { Logger } from '@nova/shared';
import {
  renderBuyCardPng,
  renderSellCardPng,
  type BuyCardData,
  type SellCardData,
} from './cards/render.js';
import { buildBuyCaption, buildShareCaption } from './cards/captions.js';
import { buildBuyCardKeyboard, buildSellCardKeyboard } from './cards/keyboards.js';
import { escapeMd } from './ui/format.js';

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
  // Optional exit-strategy display fields — see adaptiveTrailingStop.ts. Undefined
  // for positions not using the trailing-stop-preset system (today's default).
  entryPriceUsd?: number;
  athUsd?: number;
  lockedProfitPercent?: number;
}

export interface NewTokenNotification {
  mint: string;
  dex: string;
  name?: string;
  symbol?: string;
  liquidityUsd?: number;
  marketCapUsd?: number;
  aiScore?: number;
  // 2026-07-15 Telegram alert audit: true when `aiScore` came from a real AI
  // provider call, false/undefined when it's the rule-based fallback score
  // (no AI provider configured, or the AI call was skipped) — see
  // formatNewTokenMessage, which must never label a rule score "AI Score".
  isAiScore?: boolean;
  isHoneypotSuspected?: boolean;
  mintAuthorityRevoked?: boolean;
  freezeAuthorityRevoked?: boolean;
  lpBurnedOrLocked?: boolean;
  top10HolderPercent?: number;
  // Real DexScreener priceChange %, not a computed/invented formula.
  priceChangeH1?: number;
}

export interface AiHighScoreNotification {
  mint: string;
  dex: string;
  name?: string;
  symbol?: string;
  aiScore: number;
  // See NewTokenNotification.isAiScore's doc comment — same meaning here.
  isAiScore?: boolean;
  liquidityUsd?: number;
}

export interface MigrationNotification {
  mint: string;
  symbol?: string;
  fromDex: string;
  toDex: string;
}

/** Sent once per profitable closed trade by the fee/referral system's event-bus
 * subscriber (apps/api/src/business/registerFeeSystem.ts) — a distinct, separate
 * message from the existing Sell Signal/exit alert, never replacing it. */
export interface TradeReportData {
  symbol: string;
  grossProfitUsd: number;
  tradingCostsUsd: number;
  netProfitUsd: number;
  feeBps: number;
  feeUsd: number;
  userShareUsd: number;
  referralRewardsTotalUsd: number;
  referenceId: string;
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
  // token.name/token.symbol are on-chain SPL token metadata — anyone can mint a
  // token with a "_"/"*"/"`" in its name/symbol, which would otherwise break
  // Telegram's legacy Markdown parser and silently kill this alert (same bug
  // class as captions.ts's buildShareCaption and alerts.ts's action labels).
  const name = token.name ? escapeMd(token.name) : undefined;
  const symbol = token.symbol ? escapeMd(token.symbol) : undefined;
  const nameLine =
    name || symbol
      ? `\n${name ?? ''}${name && symbol ? ' — ' : ''}${symbol ? `$${symbol}` : ''}`
      : '';
  const liquidityLine =
    token.liquidityUsd !== undefined ? `\nLiquidity: $${token.liquidityUsd.toFixed(0)}` : '';
  const marketCapLine =
    token.marketCapUsd !== undefined ? `\nMarket Cap: $${token.marketCapUsd.toFixed(0)}` : '';
  const scoreLine =
    token.aiScore !== undefined
      ? `\n${token.isAiScore ? 'AI Score' : 'Rule Score (no AI provider)'}: ${token.aiScore.toFixed(0)}/100`
      : '';
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
  const momentumLine =
    token.priceChangeH1 !== undefined
      ? `\nMomentum (1h): ${token.priceChangeH1 >= 0 ? '📈' : '📉'} ${token.priceChangeH1.toFixed(1)}%`
      : '';
  const honeypotLine = token.isHoneypotSuspected ? '\n⚠️ Honeypot/rug risk flagged' : '';
  return (
    `${riskEmoji} *New ${escapeMd(token.dex)} launch*${nameLine}\n` +
    `\`${token.mint}\`${liquidityLine}${marketCapLine}${scoreLine}${riskLine}${momentumLine}${honeypotLine}\n` +
    linksLine(token.mint, token.dex)
  );
}

/**
 * 85/100 — chosen as a clearly "exceptional, not just passing" bar: SnipeConfig's
 * own minAiScore default is 60 (a buy-gate, not an alert threshold), so 85 flags
 * only the top slice of launches as distinctly alert-worthy, not everything that
 * would already pass a typical auto-buy filter. A reasonable starting point, not
 * a backtested value — tune via AI_HIGH_SCORE_THRESHOLD if it fires too often/rarely.
 */
export const AI_HIGH_SCORE_THRESHOLD = 85;

export function formatAiHighScoreMessage(token: AiHighScoreNotification): string {
  const name = token.name ? escapeMd(token.name) : undefined;
  const symbol = token.symbol ? escapeMd(token.symbol) : undefined;
  const nameLine =
    name || symbol
      ? ` ${name ?? ''}${name && symbol ? ' — ' : ''}${symbol ? `$${symbol}` : ''}`
      : '';
  const liquidityLine =
    token.liquidityUsd !== undefined ? `\nLiquidity: $${token.liquidityUsd.toFixed(0)}` : '';
  const label = token.isAiScore ? 'AI High Score' : 'High Rule Score (no AI provider)';
  return (
    `⭐ *${label}* (${token.aiScore.toFixed(0)}/100)${nameLine}\n` +
    `${escapeMd(token.dex)}\n` +
    `\`${token.mint}\`${liquidityLine}\n` +
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
    `${emoji} *${trade.side}*${paperTag} \`${escapeMd(trade.symbol)}\`\n` +
    `Amount: ${trade.amountSol} SOL${priceLine}${txLine}${linkLine}`
  );
}

function formatExitMessage(exit: PositionExitNotification): string {
  const emoji = exit.pnlPercent >= 0 ? '✅' : '⚠️';
  const paperTag = exit.isPaperTrade ? ' 📝 PAPER' : '';
  const reasonLabel = exit.reason.replace(/_/g, ' ');
  const entryLine =
    exit.entryPriceUsd !== undefined ? `\nEntry: $${exit.entryPriceUsd.toFixed(8)}` : '';
  const athLine = exit.athUsd !== undefined ? `\nATH: $${exit.athUsd.toFixed(8)}` : '';
  const lockedLine =
    exit.lockedProfitPercent !== undefined
      ? `\nLocked profit: ${exit.lockedProfitPercent.toFixed(2)}%`
      : '';
  const linkLine = exit.mint ? `\n${linksLine(exit.mint, exit.dex)}` : '';
  return (
    `${emoji}${paperTag} Position closed: \`${escapeMd(exit.symbol)}\`\n` +
    `Reason: ${reasonLabel}\n` +
    `PnL: ${exit.pnlPercent.toFixed(2)}%${entryLine}${athLine}${lockedLine}${linkLine}`
  );
}

/** Pure so it's independently unit-tested, same convention as formatNewTokenMessage. */
export function formatTradeReportMessage(report: TradeReportData): string {
  const referralLine =
    report.referralRewardsTotalUsd > 0
      ? `\n🔗 Referral Rewards: $${report.referralRewardsTotalUsd.toFixed(2)}`
      : '';
  return (
    `📊 *Trade Report* — \`${escapeMd(report.symbol)}\`\n\n` +
    `Gross Profit: $${report.grossProfitUsd.toFixed(2)}\n` +
    `Trading Costs: $${report.tradingCostsUsd.toFixed(2)}\n` +
    `Net Profit: $${report.netProfitUsd.toFixed(2)}\n` +
    `Platform Performance Fee (${(report.feeBps / 100).toFixed(1)}%): $${report.feeUsd.toFixed(2)}${referralLine}\n` +
    `*Final Amount Credited: $${report.userShareUsd.toFixed(2)}*\n\n` +
    `_Ref: ${report.referenceId}_`
  );
}

/**
 * All Telegram alert delivery goes through this one class — the owner's configured
 * broadcast chat, plus (for the sniper alert types: trade/exit/new-token/migration)
 * every other user whose own SnipeConfig is currently live, so a referral-reward-
 * activated user sees exactly the same alerts as the owner, not a lesser or absent
 * feed. notifyMigration fans out too — migration is the dominant real-world path a
 * token ever reaches PumpSwap/Raydium/Orca/Meteora, not a fresh pool creation, so
 * treating it as owner-only was why active users effectively only ever saw Pump.fun
 * alerts. notifyError/notifySocialMention stay owner-only — genuine operational/ops
 * signals, not a DEX/trading alert type, and nobody asked to have system errors or
 * Twitter mentions pushed to every active user.
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

  private async sendPhotoToChat(
    chatId: string,
    png: Buffer,
    caption: string,
    keyboard: InlineKeyboard,
  ): Promise<void> {
    try {
      await this.bot.api.sendPhoto(chatId, new InputFile(png), {
        caption,
        parse_mode: 'Markdown',
        reply_markup: keyboard,
      });
    } catch (err) {
      this.logger.error({ err, chatId }, 'failed to send telegram trade card');
    }
  }

  /** Fans a pre-rendered card photo out to the owner + every currently-active user, identical to each. */
  private async sendPhotoToActiveUsers(
    png: Buffer,
    caption: string,
    keyboard: InlineKeyboard,
  ): Promise<void> {
    const chatIds = await this.activeRecipientChatIds();
    await Promise.all(
      chatIds.map((chatId) => this.sendPhotoToChat(chatId, png, caption, keyboard)),
    );
  }

  private cachedBotUsername: string | undefined;
  private async getBotUsername(): Promise<string | undefined> {
    if (this.cachedBotUsername) return this.cachedBotUsername;
    try {
      const me = await this.bot.api.getMe();
      this.cachedBotUsername = me.username;
      return me.username;
    } catch (err) {
      this.logger.error({ err }, 'failed to resolve bot username for share caption');
      return undefined;
    }
  }

  /**
   * Institutional-style trade card, generated and sent immediately after every
   * successful BUY — fans out identically to every active user (see class doc).
   */
  async notifyBuyCard(data: BuyCardData): Promise<void> {
    try {
      const png = await renderBuyCardPng(data);
      const caption = buildBuyCaption(data);
      const keyboard = buildBuyCardKeyboard(data.token.mint);
      await this.sendPhotoToActiveUsers(png, caption, keyboard);
    } catch (err) {
      this.logger.error(
        { err, positionId: data.positionId },
        'failed to generate/send BUY trade card',
      );
    }
  }

  /**
   * Institutional-style trade card, generated and sent after every close (TP/SL/
   * trailing/manual) — fans out identically to every active user. Returns the
   * generated share caption (or undefined on failure) so the caller can persist
   * it onto the Position row for the 🔗 Share button to resend later.
   */
  async notifySellCard(data: SellCardData): Promise<string | undefined> {
    try {
      const png = await renderSellCardPng(data);
      const botUsername = await this.getBotUsername();
      const caption = buildShareCaption(data, botUsername);
      const keyboard = buildSellCardKeyboard(data.token.mint, data.positionId);
      await this.sendPhotoToActiveUsers(png, caption, keyboard);
      return caption;
    } catch (err) {
      this.logger.error(
        { err, positionId: data.positionId },
        'failed to generate/send SELL trade card',
      );
      return undefined;
    }
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

  /** Distinct alert type, fired in addition to the regular New Launch alert when aiScore crosses AI_HIGH_SCORE_THRESHOLD. */
  async notifyAiHighScore(token: AiHighScoreNotification): Promise<void> {
    await this.sendToActiveUsers(formatAiHighScoreMessage(token));
  }

  async notifyError(context: string, message: string): Promise<void> {
    // `message` is an arbitrary caught error/exception message from anywhere in the
    // app — stack traces and error text routinely contain "_"/"*"/"`", which would
    // otherwise break Telegram's legacy Markdown parser and silently swallow the
    // one alert an operator relies on to notice something is broken.
    await this.sendToOwner(`🚨 *Error* in ${escapeMd(context)}\n${escapeMd(message)}`);
  }

  async notifySocialMention(text: string, tweetId: string): Promise<void> {
    await this.sendToOwner(
      `🐦 *X mention*\n${escapeMd(text.slice(0, 300))}\n` +
        `[View](https://x.com/i/web/status/${tweetId})`,
    );
  }

  /**
   * Fans out like the other DEX-relevant alerts (not owner-only): migration from
   * pump.fun's bonding curve is the dominant real-world path a token ever reaches
   * PumpSwap/Raydium/Orca/Meteora — direct pool creation on those DEXs is far
   * rarer. Treating this as owner-only was the actual reason active users only
   * ever saw Pump.fun alerts: most non-Pump.fun tokens they'd want to know about
   * arrive via this exact path, not a fresh launch on that DEX.
   */
  async notifyMigration(migration: MigrationNotification): Promise<void> {
    const label = migration.symbol ?? migration.mint.slice(0, 8);
    await this.sendToActiveUsers(
      `🚀 *Migration detected*: \`${escapeMd(label)}\`\n` +
        `${escapeMd(migration.fromDex)} → ${escapeMd(migration.toDex)}\n` +
        `${linksLine(migration.mint, migration.toDex)}`,
    );
  }

  /**
   * Targeted at the ONE user whose trade this is — unlike every other alert
   * type above, this is never fanned out to the owner/other active users
   * (a trade report is personal financial information, not a DEX signal).
   * A silent no-op if the user has no telegramId on file (e.g. a
   * dashboard-only account) — same best-effort convention as every send here.
   */
  async notifyTradeReport(userId: string, report: TradeReportData): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { telegramId: true },
    });
    if (!user?.telegramId) return;
    await this.sendToChat(user.telegramId, formatTradeReportMessage(report));
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
