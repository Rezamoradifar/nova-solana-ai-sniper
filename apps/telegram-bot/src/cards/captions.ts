import { escapeMd } from '../ui/format.js';
import type { BuyCardData, SellCardData } from './render.js';

/** Caption sent with the BUY card photo — exact format requested. */
export function buildBuyCaption(data: BuyCardData): string {
  const tokenLabel = escapeMd(
    data.token.symbol ? `$${data.token.symbol}` : data.token.mint.slice(0, 8),
  );
  return (
    `🎯 *Nova Sniper AI*\n\n` +
    `Successfully entered a new position.\n\n` +
    `Token: ${tokenLabel}\n` +
    `DEX: ${escapeMd(data.token.dex)}\n\n` +
    `AI Score: ${data.token.aiScore !== undefined ? data.token.aiScore.toFixed(0) : '—'}/100`
  );
}

/**
 * The "SOCIAL SHARE" ready-to-post caption — used both as the SELL card's own
 * photo caption (profit/ROI are only meaningful once a trade has actually closed)
 * and as what the 🔗 Share button resends as a separate, easily-copyable message.
 */
export function buildShareCaption(data: SellCardData, botUsername: string | undefined): string {
  // Both are attacker/config-controlled strings landing in a parse_mode:'Markdown'
  // message — an unescaped "_" (extremely common in Telegram bot usernames, e.g.
  // "Solanxaxsniper_bot") reads as an unterminated italic entity and makes
  // Telegram reject the whole send with a 400, silently killing every SELL card.
  const tokenLabel = escapeMd(
    data.token.symbol ? `$${data.token.symbol}` : data.token.mint.slice(0, 8),
  );
  const profitSign = data.profitSol >= 0 ? '+' : '';
  const pnlSign = data.pnlPercent >= 0 ? '+' : '';
  const botLine = botUsername ? `https://t.me/${escapeMd(botUsername)}` : '';
  return (
    `🚀 Trade completed with Nova Sniper AI\n\n` +
    `💰 Profit: ${pnlSign}${data.pnlPercent.toFixed(0)}%\n\n` +
    `💎 ${profitSign}${data.profitSol.toFixed(2)} SOL\n\n` +
    `📈 ROI: ${pnlSign}${data.roiPercent.toFixed(0)}%\n\n` +
    (data.token.aiScore !== undefined
      ? `🤖 AI Score: ${data.token.aiScore.toFixed(0)}/100\n\n`
      : '') +
    `${tokenLabel} on ${escapeMd(data.token.dex)}\n\n` +
    `Trade faster with Nova Sniper AI.\n` +
    botLine
  ).trim();
}
