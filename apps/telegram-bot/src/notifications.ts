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
import { resolveLocale, t, type Locale } from './i18n/index.js';

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
  reason: 'take_profit' | 'stop_loss' | 'trailing_stop' | 'emergency' | 'manual_emergency';
  pnlPercent: number;
  pnlUsd?: number;
  isPaperTrade?: boolean;
  // Optional exit-strategy display fields — see adaptiveTrailingStop.ts. Undefined
  // for positions not using the trailing-stop-preset system (today's default).
  entryPriceUsd?: number;
  athUsd?: number;
  lockedProfitPercent?: number;
}

/** Sent by emergencyExitMonitor.ts — distinct from (and in addition to) the
 * standard notifyExit alert every close already gets, since a plain "Reason:
 * emergency" doesn't say WHY. `reason`/`detail` mirror
 * EmergencyExitDecision from emergencyExit.ts. */
export interface EmergencyExitNotification {
  symbol: string;
  mint: string;
  dex?: string;
  reason:
    | 'liquidity_removed'
    | 'trading_disabled'
    | 'mint_reenabled'
    | 'freeze_reenabled'
    | 'critical_rug_score'
    | 'dev_wallet_dump';
  detail: string;
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

/** Sent by registerFeeSystem.ts to a referrer, once per grant — Section 14
 * (2026-07-18): a referrer earns a fixed 10%/5% of a referred trader's net
 * profit at Level 1/2, independent of the platform's own performance fee. */
export interface ReferralEarnedNotification {
  level: 1 | 2;
  rewardUsd: number;
  sourceSymbol: string;
}

/**
 * Section 8 audit (2026-07-23, "excessive Telegram alerts" incident) — the
 * periodic replacement for what used to be one individual alert per rejected
 * candidate. Sent by securityGateSummaryReporter.ts on a fixed interval
 * (default 15 minutes), never per-candidate.
 */
export interface SecurityGateSummaryReport {
  candidatesScanned: number;
  passedSecurity: number;
  /** Live snapshot at report time (currently sitting in a retry backoff),
   * not a count of events during the window — see securityGateStats.ts. */
  pendingVerification: number;
  blocked: number;
  /** Raw reason code -> count for this window, e.g. `honeypot_suspected: 20`. */
  blockedReasonCounts: Record<string, number>;
  aiConsensusRejected: number;
  providerUnavailableCount: number;
  averageVerificationLatencyMs?: number;
  retrySuccessRate?: number;
}

/** Human-readable labels for the raw reason codes candidatePipeline.ts/
 * criticalSecurityGate.ts produce — falls back to the raw code (escaped) for
 * anything not in this list, so a new reason added later never goes missing
 * from the report, just unstyled. */
const SECURITY_GATE_REASON_LABELS: Record<string, string> = {
  honeypot_suspected: 'Confirmed honeypot signal',
  honeypot_check_unknown: 'Honeypot check unavailable',
  holder_concentration_critical: 'Holder concentration critical',
  holder_count_critical: 'Holder count critical',
  holder_data_unknown: 'Holder data unavailable',
  bundled_wallet_cluster_detected: 'Bundled wallets detected',
  dexscreener_validation_failed: 'DexScreener validation unavailable/pending',
  lp_not_locked_or_burned: 'No liquidity resolved yet',
  mint_authority_not_revoked: 'Mint authority not revoked',
  mint_authority_unknown: 'Mint authority check unavailable',
  freeze_authority_not_revoked: 'Freeze authority not revoked',
  freeze_authority_unknown: 'Freeze authority check unavailable',
  deployer_blacklisted: 'Deployer blacklisted',
  mint_blacklisted: 'Mint blacklisted',
  deployer_check_failed: 'Deployer blacklist check failed',
  mint_check_failed: 'Mint blacklist check failed',
  no_sell_route: 'No sell route',
  sellability_check_failed: 'Sellability check unavailable',
  exit_price_impact_too_high: 'Sell price impact too high',
  risk_analysis_failed: 'Risk analysis failed',
};

/** Pure so it's independently unit-tested, same convention as every other
 * format*Message function in this file. Not localized (same convention as
 * formatErrorMessage/notifyError below) — this is an owner-only ops report,
 * not a user-facing trading alert. */
export function formatSecurityGateSummaryMessage(report: SecurityGateSummaryReport): string {
  const reasonLines = Object.entries(report.blockedReasonCounts)
    .sort(([, a], [, b]) => b - a)
    .map(
      ([reason, count]) => `${SECURITY_GATE_REASON_LABELS[reason] ?? escapeMd(reason)}: ${count}`,
    )
    .join('\n');

  const latencyLine =
    report.averageVerificationLatencyMs !== undefined
      ? `\nAvg verification latency: ${(report.averageVerificationLatencyMs / 1000).toFixed(1)}s`
      : '';
  const retryLine =
    report.retrySuccessRate !== undefined
      ? `\nRetry success rate: ${(report.retrySuccessRate * 100).toFixed(0)}%`
      : '';
  const consensusLine =
    report.aiConsensusRejected > 0 ? `\nAI consensus rejected: ${report.aiConsensusRejected}` : '';

  return (
    `🛡️ *Security Gate Summary* — Last 15 minutes\n\n` +
    `Candidates scanned: ${report.candidatesScanned}\n` +
    `Passed security: ${report.passedSecurity}\n` +
    `Pending verification: ${report.pendingVerification}\n` +
    `Blocked: ${report.blocked}\n` +
    `Provider unavailable: ${report.providerUnavailableCount}` +
    `${consensusLine}${latencyLine}${retryLine}\n\n` +
    `${reasonLines.length > 0 ? `Reasons:\n${reasonLines}` : ''}`
  ).trim();
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
export function formatNewTokenMessage(token: NewTokenNotification, lang: Locale = 'en'): string {
  const d = t(lang).notifications;
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
    token.liquidityUsd !== undefined
      ? `\n${d.liquidityLabel}: $${token.liquidityUsd.toFixed(0)}`
      : '';
  const marketCapLine =
    token.marketCapUsd !== undefined
      ? `\n${d.marketCapLabel}: $${token.marketCapUsd.toFixed(0)}`
      : '';
  const scoreLine =
    token.aiScore !== undefined
      ? `\n${token.isAiScore ? d.aiScoreLabel : d.ruleScoreLabel}: ${token.aiScore.toFixed(0)}/100`
      : '';
  const riskParts: string[] = [];
  if (token.mintAuthorityRevoked !== undefined) {
    riskParts.push(`${d.mintLabel} ${token.mintAuthorityRevoked ? '✅' : '⚠️'}`);
  }
  if (token.freezeAuthorityRevoked !== undefined) {
    riskParts.push(`${d.freezeLabel} ${token.freezeAuthorityRevoked ? '✅' : '⚠️'}`);
  }
  if (token.lpBurnedOrLocked !== undefined) {
    riskParts.push(`${d.lpLabel} ${token.lpBurnedOrLocked ? '🔒' : '⚠️'}`);
  }
  if (token.top10HolderPercent !== undefined) {
    riskParts.push(`${d.top10Label} ${token.top10HolderPercent.toFixed(0)}%`);
  }
  const riskLine = riskParts.length > 0 ? `\n${d.riskLabel}: ${riskParts.join(' | ')}` : '';
  const momentumLine =
    token.priceChangeH1 !== undefined
      ? `\n${d.momentumLabel}: ${token.priceChangeH1 >= 0 ? '📈' : '📉'} ${token.priceChangeH1.toFixed(1)}%`
      : '';
  const honeypotLine = token.isHoneypotSuspected ? `\n${d.honeypotFlag}` : '';
  return (
    `${riskEmoji} ${d.newLaunch(escapeMd(token.dex))}${nameLine}\n` +
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

export function formatAiHighScoreMessage(
  token: AiHighScoreNotification,
  lang: Locale = 'en',
): string {
  const d = t(lang).notifications;
  const name = token.name ? escapeMd(token.name) : undefined;
  const symbol = token.symbol ? escapeMd(token.symbol) : undefined;
  const nameLine =
    name || symbol
      ? ` ${name ?? ''}${name && symbol ? ' — ' : ''}${symbol ? `$${symbol}` : ''}`
      : '';
  const liquidityLine =
    token.liquidityUsd !== undefined
      ? `\n${d.liquidityLabel}: $${token.liquidityUsd.toFixed(0)}`
      : '';
  const label = token.isAiScore ? d.aiHighScoreLabel : d.highRuleScoreLabel;
  return (
    `⭐ *${label}* (${token.aiScore.toFixed(0)}/100)${nameLine}\n` +
    `${escapeMd(token.dex)}\n` +
    `\`${token.mint}\`${liquidityLine}\n` +
    linksLine(token.mint, token.dex)
  );
}

function formatTradeMessage(trade: TradeNotification, lang: Locale = 'en'): string {
  const d = t(lang).notifications;
  const emoji = trade.side === 'BUY' ? '🟢' : '🔴';
  const paperTag = trade.isPaperTrade ? ' 📝 PAPER' : '';
  const priceLine = trade.priceUsd ? `\n${d.priceLabel}: $${trade.priceUsd.toFixed(6)}` : '';
  const txLine = trade.isPaperTrade
    ? `\n${d.simulatedFill}`
    : `\n[Tx](https://solscan.io/tx/${trade.signature})`;
  const linkLine = `\n${linksLine(trade.mint, trade.dex)}`;
  return (
    `${emoji} *${trade.side}*${paperTag} \`${escapeMd(trade.symbol)}\`\n` +
    `${d.amountLabel}: ${trade.amountSol} SOL${priceLine}${txLine}${linkLine}`
  );
}

function formatExitMessage(exit: PositionExitNotification, lang: Locale = 'en'): string {
  const d = t(lang).notifications;
  const emoji = exit.pnlPercent >= 0 ? '✅' : '⚠️';
  const paperTag = exit.isPaperTrade ? ' 📝 PAPER' : '';
  const reasonLabel = d.exitReasonLabels[exit.reason] ?? exit.reason.replace(/_/g, ' ');
  const entryLine =
    exit.entryPriceUsd !== undefined ? `\n${d.entryLabel}: $${exit.entryPriceUsd.toFixed(8)}` : '';
  const athLine = exit.athUsd !== undefined ? `\n${d.athLabel}: $${exit.athUsd.toFixed(8)}` : '';
  const lockedLine =
    exit.lockedProfitPercent !== undefined
      ? `\n${d.lockedProfitLabel}: ${exit.lockedProfitPercent.toFixed(2)}%`
      : '';
  const linkLine = exit.mint ? `\n${linksLine(exit.mint, exit.dex)}` : '';
  return (
    `${emoji}${paperTag} ${d.positionClosedLabel}: \`${escapeMd(exit.symbol)}\`\n` +
    `${d.reasonLabel}: ${reasonLabel}\n` +
    `${d.pnlLabel}: ${exit.pnlPercent.toFixed(2)}%${entryLine}${athLine}${lockedLine}${linkLine}`
  );
}

/** Pure so it's independently unit-tested, same convention as formatExitMessage.
 * Deliberately more alarming than the standard exit alert (double-emoji, ALL
 * CAPS header) — this fires only when the position was force-closed against
 * a real detected rug signal, not a routine TP/SL/trailing-stop. */
export function formatEmergencyExitMessage(
  exit: EmergencyExitNotification,
  lang: Locale = 'en',
): string {
  const d = t(lang).notifications;
  const paperTag = exit.isPaperTrade ? ' 📝 PAPER' : '';
  const pnlUsdLine = exit.pnlUsd !== undefined ? ` ($${exit.pnlUsd.toFixed(2)})` : '';
  const linkLine = `\n${linksLine(exit.mint, exit.dex)}`;
  return (
    `🚨🚨 *${d.emergencyExitLabel}*${paperTag} — \`${escapeMd(exit.symbol)}\`\n\n` +
    `${d.reasonLabel}: *${escapeMd(d.emergencyReasonLabels[exit.reason] ?? exit.reason)}*\n` +
    `${escapeMd(exit.detail)}\n\n` +
    `${d.pnlLabel}: ${exit.pnlPercent.toFixed(2)}%${pnlUsdLine}${linkLine}`
  );
}

/** Pure so it's independently unit-tested, same convention as formatNewTokenMessage. */
export function formatTradeReportMessage(report: TradeReportData, lang: Locale = 'en'): string {
  const d = t(lang).notifications;
  const referralLine =
    report.referralRewardsTotalUsd > 0
      ? `\n🔗 ${d.referralRewardsLabel}: $${report.referralRewardsTotalUsd.toFixed(2)}`
      : '';
  return (
    `📊 *${d.tradeReportTitle}* — \`${escapeMd(report.symbol)}\`\n\n` +
    `${d.grossProfitLabel}: $${report.grossProfitUsd.toFixed(2)}\n` +
    `${d.tradingCostsLabel}: $${report.tradingCostsUsd.toFixed(2)}\n` +
    `${d.netProfitLabel}: $${report.netProfitUsd.toFixed(2)}\n` +
    `${d.performanceFeeLabel((report.feeBps / 100).toFixed(1))}: $${report.feeUsd.toFixed(2)}${referralLine}\n` +
    `*${d.finalAmountCreditedLabel}: $${report.userShareUsd.toFixed(2)}*\n\n` +
    `_${d.refLabel}: ${report.referenceId}_`
  );
}

/** Pure so it's independently unit-tested, same convention as formatTradeReportMessage. */
export function formatReferralEarnedMessage(
  data: ReferralEarnedNotification,
  lang: Locale = 'en',
): string {
  const d = t(lang).notifications;
  return (
    `🔗 *${d.referralEarnedTitle}*\n\n` +
    `${d.referralEarnedBody(data.level, escapeMd(data.sourceSymbol))}\n\n` +
    `${d.youEarnedLabel}: *$${data.rewardUsd.toFixed(2)}*`
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
   * De-duplicated by chatId, so an owner who is also an active user (or two active
   * SnipeConfig rows for the same person) never gets the same alert twice. Carries
   * each recipient's own `language` so sendToActiveUsers can format the alert text
   * per-recipient rather than broadcasting one language to everyone.
   */
  private async activeRecipients(): Promise<{ chatId: string; lang: Locale }[]> {
    const [ownerRow, activeUsers] = await Promise.all([
      this.prisma.user.findUnique({
        where: { telegramId: this.ownerChatId },
        select: { language: true },
      }),
      this.prisma.user.findMany({
        where: {
          telegramId: { not: null },
          snipeConfigs: { some: { isActive: true, autoBuyOnLaunch: true } },
        },
        select: { telegramId: true, language: true },
      }),
    ]);
    const byChatId = new Map<string, Locale>();
    byChatId.set(this.ownerChatId, resolveLocale(ownerRow?.language));
    for (const u of activeUsers) {
      byChatId.set(u.telegramId!, resolveLocale(u.language));
    }
    return [...byChatId.entries()].map(([chatId, lang]) => ({ chatId, lang }));
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

  /** Fans out to the owner + every currently-active user, formatting the message in
   * each recipient's own language via `build`. */
  private async sendToActiveUsers(build: (lang: Locale) => string): Promise<void> {
    const recipients = await this.activeRecipients();
    await Promise.all(recipients.map(({ chatId, lang }) => this.sendToChat(chatId, build(lang))));
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

  /** Fans a pre-rendered card photo out to the owner + every currently-active user, identical to each.
   * Trade cards (cards/*) are unlocalized — the caption is the same for every recipient
   * regardless of their language setting. */
  private async sendPhotoToActiveUsers(
    png: Buffer,
    caption: string,
    keyboard: InlineKeyboard,
  ): Promise<void> {
    const recipients = await this.activeRecipients();
    await Promise.all(
      recipients.map(({ chatId }) => this.sendPhotoToChat(chatId, png, caption, keyboard)),
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
    await this.sendToActiveUsers((lang) => formatTradeMessage(trade, lang));
  }

  async notifyExit(exit: PositionExitNotification): Promise<void> {
    await this.sendToActiveUsers((lang) => formatExitMessage(exit, lang));
  }

  async notifyEmergencyExit(exit: EmergencyExitNotification): Promise<void> {
    await this.sendToActiveUsers((lang) => formatEmergencyExitMessage(exit, lang));
  }

  async notifyNewToken(token: NewTokenNotification): Promise<void> {
    await this.sendToActiveUsers((lang) => formatNewTokenMessage(token, lang));
  }

  /** Distinct alert type, fired in addition to the regular New Launch alert when aiScore crosses AI_HIGH_SCORE_THRESHOLD. */
  async notifyAiHighScore(token: AiHighScoreNotification): Promise<void> {
    await this.sendToActiveUsers((lang) => formatAiHighScoreMessage(token, lang));
  }

  async notifyError(context: string, message: string): Promise<void> {
    // `message` is an arbitrary caught error/exception message from anywhere in the
    // app — stack traces and error text routinely contain "_"/"*"/"`", which would
    // otherwise break Telegram's legacy Markdown parser and silently swallow the
    // one alert an operator relies on to notice something is broken.
    await this.sendToOwner(`🚨 *Error* in ${escapeMd(context)}\n${escapeMd(message)}`);
  }

  /** Owner-only, same convention as notifyError/notifySocialMention — an
   * operational/ops signal, not a per-user trading alert. See
   * securityGateSummaryReporter.ts, which calls this on a fixed interval. */
  async notifySecurityGateSummary(report: SecurityGateSummaryReport): Promise<void> {
    await this.sendToOwner(formatSecurityGateSummaryMessage(report));
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
      (lang) =>
        `🚀 *${t(lang).notifications.migrationDetectedLabel}*: \`${escapeMd(label)}\`\n` +
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
      select: { telegramId: true, language: true },
    });
    if (!user?.telegramId) return;
    await this.sendToChat(
      user.telegramId,
      formatTradeReportMessage(report, resolveLocale(user.language)),
    );
  }

  /** Same single-recipient convention as notifyTradeReport — a wallet-balance
   * warning is specific to the one user whose auto-buy is being skipped, not
   * a DEX/trading alert, so never fanned out. Silent no-op if the user has no
   * telegramId on file. See AutoTrader.evaluateAndMaybeBuy's SafetyCheckError
   * handling — the caller is expected to dedup (e.g. via TtlCache) so this
   * isn't fired on every single skipped launch for the same user. Returns
   * whether the send actually succeeded (unlike sendToChat's void
   * fire-and-forget) so a one-off caller (e.g. an admin script) can report
   * real per-recipient delivery status instead of just "attempted" — `false`
   * covers both a Telegram-side send failure and "no telegramId on file". */
  async notifyLowWalletBalance(
    userId: string,
    data: { balanceSol: number; requiredSol: number },
  ): Promise<boolean> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { telegramId: true, language: true },
    });
    if (!user?.telegramId) return false;
    const lang = resolveLocale(user.language);
    const d = t(lang).notifications;
    const shortfall = data.requiredSol - data.balanceSol;
    const text =
      `⚠️ *${d.lowBalanceTitle}*\n\n` +
      `${d.lowBalanceBody(data.balanceSol.toFixed(4), data.requiredSol.toFixed(4))}\n\n` +
      `${d.lowBalanceSkipNote(shortfall.toFixed(4))}\n\n` +
      `${d.lowBalanceOneTimeNote}`;
    try {
      await this.bot.api.sendMessage(user.telegramId, text, { parse_mode: 'Markdown' });
      return true;
    } catch (err) {
      this.logger.error(
        { err, chatId: user.telegramId },
        'failed to send low-balance notification',
      );
      return false;
    }
  }

  /** Same single-recipient convention as notifyTradeReport — a referral
   * grant is personal financial information for the referrer, not a
   * DEX/trading alert, so never fanned out. Silent no-op if the referrer has
   * no telegramId on file. */
  async notifyReferralEarned(
    referrerUserId: string,
    data: ReferralEarnedNotification,
  ): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: referrerUserId },
      select: { telegramId: true, language: true },
    });
    if (!user?.telegramId) return;
    await this.sendToChat(
      user.telegramId,
      formatReferralEarnedMessage(data, resolveLocale(user.language)),
    );
  }

  /**
   * Admin-triggered one-off broadcast (e.g. ops/beta-status announcements) to the
   * same recipient set as the sniper alerts — owner + every active-SnipeConfig
   * user, via activeRecipients(). Sent with no parse_mode, deliberately
   * unlike sendToChat: admin-authored text isn't guaranteed Markdown-safe the way
   * the format*Message functions are (they escapeMd every dynamic field going
   * in), so plain text avoids a stray "_"/"*"/"`" silently breaking the send —
   * same failure class documented on formatNewTokenMessage/buildShareCaption.
   * Returns per-recipient counts (not throwing) so a CLI caller can report
   * exactly how many of the audience were actually reached.
   */
  async broadcastCustomMessage(text: string): Promise<{ sent: number; failed: number }> {
    const recipients = await this.activeRecipients();
    const results = await Promise.all(
      recipients.map(async ({ chatId }) => {
        try {
          await this.bot.api.sendMessage(chatId, text);
          return true;
        } catch (err) {
          this.logger.error({ err, chatId }, 'failed to send broadcast message');
          return false;
        }
      }),
    );
    const sent = results.filter(Boolean).length;
    return { sent, failed: results.length - sent };
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
  lang: Locale = 'en',
): Promise<void> {
  const d = t(lang).notifications;
  try {
    await api.sendMessage(
      chatId,
      `🎉 *${d.referralRewardUnlockedTitle}*\n\n` +
        `${d.referralRewardUnlockedBody(referredCount)}\n` +
        `${d.referralRewardCheckNote(t(lang).common.menu.sniperStart)}`,
      { parse_mode: 'Markdown' },
    );
  } catch (err) {
    logger.error({ err }, 'failed to send referral reward telegram notification');
  }
}
