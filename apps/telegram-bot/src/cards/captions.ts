import { escapeMd } from '../ui/format.js';
import type { BuyCardData, SellCardData } from './render.js';

/** Fixed-precision number with an explicit sign; a value that rounds to zero gets none. */
function signedFixed(n: number, digits: number): string {
  const r = Math.abs(n).toFixed(digits);
  if (Number(r) === 0) return r;
  return `${n > 0 ? '+' : '-'}${r}`;
}

/** Caption sent with the BUY card photo — exact format requested. */
export function buildBuyCaption(data: BuyCardData): string {
  const tokenLabel = escapeMd(
    data.token.symbol ? `$${data.token.symbol}` : data.token.mint.slice(0, 8),
  );
  return (
    `🎯 *GSP Bank Sniper*\n\n` +
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
  const botLine = botUsername ? `https://t.me/${escapeMd(botUsername)}` : '';
  return (
    `🚀 Trade completed with GSP Bank Sniper\n\n` +
    `💰 Profit: ${signedFixed(data.pnlPercent, 1)}%\n\n` +
    `💎 ${signedFixed(data.profitSol, 4)} SOL\n\n` +
    `📈 ROI: ${signedFixed(data.roiPercent, 1)}%\n\n` +
    (data.token.aiScore !== undefined
      ? `🤖 AI Score: ${data.token.aiScore.toFixed(0)}/100\n\n`
      : '') +
    `${tokenLabel} on ${escapeMd(data.token.dex)}\n\n` +
    `Trade faster with GSP Bank Sniper.\n` +
    botLine
  ).trim();
}
