import type { Bot } from 'grammy';
import type { Logger } from '@nova/shared';

export interface TradeNotification {
  side: 'BUY' | 'SELL';
  symbol: string;
  mint: string;
  amountSol: number;
  priceUsd?: number;
  signature: string;
}

export interface PositionExitNotification {
  symbol: string;
  reason: 'take_profit' | 'stop_loss' | 'trailing_stop';
  pnlPercent: number;
  pnlUsd?: number;
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
    const priceLine = trade.priceUsd ? `\nPrice: $${trade.priceUsd.toFixed(6)}` : '';
    await this.send(
      `${emoji} *${trade.side}* \`${trade.symbol}\`\n` +
        `Amount: ${trade.amountSol} SOL${priceLine}\n` +
        `[Tx](https://solscan.io/tx/${trade.signature})`,
    );
  }

  async notifyExit(exit: PositionExitNotification): Promise<void> {
    const emoji = exit.pnlPercent >= 0 ? '✅' : '⚠️';
    const reasonLabel = exit.reason.replace(/_/g, ' ');
    await this.send(
      `${emoji} Position closed: \`${exit.symbol}\`\n` +
        `Reason: ${reasonLabel}\n` +
        `PnL: ${exit.pnlPercent.toFixed(2)}%`,
    );
  }

  async notifyError(context: string, message: string): Promise<void> {
    await this.send(`🚨 *Error* in ${context}\n${message}`);
  }
}
