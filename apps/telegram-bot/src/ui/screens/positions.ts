import { InlineKeyboard } from 'grammy';
import type { Position, Token } from '@prisma/client';
import { withNav } from '../keyboards.js';
import { sol, escapeMd } from '../format.js';
import type { ScreenDeps, ScreenResult, ScreenUser } from '../types.js';

const MAX_SHOWN = 8;

/**
 * Preset-driven positions (adaptiveTrailingStop.ts) show the full ATH/locked-profit
 * picture; everything else keeps today's plain TP/SL line unchanged. "Current
 * profit %"/"distance to stop" need a live price and aren't shown here — they're
 * on the exit alert instead, since that's computed during an actual price tick;
 * this screen only has the last stored high-water-mark, not a fresh quote.
 */
function formatPositionSummary(p: Position & { token: Token }): string {
  const symbol = escapeMd(p.token.symbol ?? p.token.mint.slice(0, 6));
  if (!p.trailingStopPreset) {
    const tp = p.takeProfitPercent ? `TP ${p.takeProfitPercent}%` : 'TP —';
    const sl = p.stopLossPercent ? `SL ${p.stopLossPercent}%` : 'SL —';
    return `🪙 ${symbol} — ${sol(p.amountSolInvested)} invested\n${tp} · ${sl}`;
  }

  const athUsd = p.highWaterMarkUsd ?? p.entryPriceUsd;
  const highestProfitPercent =
    p.entryPriceUsd > 0 ? ((athUsd - p.entryPriceUsd) / p.entryPriceUsd) * 100 : 0;
  const trailingStopPriceUsd =
    p.trailingStopPercent != null ? athUsd * (1 - p.trailingStopPercent / 100) : undefined;
  const lockedProfitPercent =
    trailingStopPriceUsd !== undefined && p.entryPriceUsd > 0
      ? ((trailingStopPriceUsd - p.entryPriceUsd) / p.entryPriceUsd) * 100
      : undefined;

  const lines = [
    `🪙 ${symbol} [${p.trailingStopPreset}] — ${sol(p.amountSolInvested)} invested`,
    `Entry: $${p.entryPriceUsd.toFixed(8)} · ATH: $${athUsd.toFixed(8)}`,
    `Highest profit: ${highestProfitPercent.toFixed(2)}%`,
  ];
  if (trailingStopPriceUsd !== undefined) {
    lines.push(
      `Trailing stop: $${trailingStopPriceUsd.toFixed(8)} (locked ${lockedProfitPercent!.toFixed(2)}%)`,
    );
  }
  return lines.join('\n');
}

export async function renderPositions(deps: ScreenDeps, user: ScreenUser): Promise<ScreenResult> {
  const [open, closedCount] = await Promise.all([
    deps.prisma.position.findMany({
      where: { status: 'OPEN', wallet: { userId: user.id } },
      include: { token: true },
      orderBy: { createdAt: 'desc' },
      take: MAX_SHOWN,
    }),
    deps.prisma.position.count({ where: { status: 'CLOSED', wallet: { userId: user.id } } }),
  ]);

  let text = '📈 *Positions*\n\n';
  const keyboard = new InlineKeyboard();

  if (open.length === 0) {
    text += 'No open positions.';
  } else {
    text += open.map(formatPositionSummary).join('\n\n');

    for (const p of open) {
      const symbol = p.token.symbol ?? p.token.mint.slice(0, 6);
      keyboard
        .text(`✏️ ${symbol} TP`, `a:positions:edittp:${p.id}`)
        .text(`✏️ ${symbol} SL`, `a:positions:editsl:${p.id}`)
        .row();
    }
  }

  text += `\n\n📜 Closed positions: *${closedCount}*`;

  return { text, keyboard: withNav(keyboard, 'home') };
}

export function takeProfitPrompt(): ScreenResult {
  return {
    text: '✏️ *Take-profit*\n\nSend the new take-profit percentage as a number (e.g. `50` for +50%).',
    keyboard: withNav(new InlineKeyboard(), 'positions'),
  };
}

export function stopLossPrompt(): ScreenResult {
  return {
    text: '✏️ *Stop-loss*\n\nSend the new stop-loss percentage as a number (e.g. `20` for -20%).',
    keyboard: withNav(new InlineKeyboard(), 'positions'),
  };
}

async function loadOwnedPosition(deps: ScreenDeps, user: ScreenUser, positionId: string) {
  const position = await deps.prisma.position.findUnique({
    where: { id: positionId },
    include: { wallet: true },
  });
  return position && position.wallet.userId === user.id ? position : null;
}

export async function applyTakeProfit(
  deps: ScreenDeps,
  user: ScreenUser,
  positionId: string,
  raw: string,
): Promise<{ ok: true; result: ScreenResult } | { ok: false; message: string }> {
  const n = Number(raw.trim());
  if (!Number.isFinite(n) || n <= 0) {
    return { ok: false, message: "That doesn't look right — send a positive number." };
  }
  const position = await loadOwnedPosition(deps, user, positionId);
  if (!position) return { ok: false, message: 'That position no longer exists.' };

  await deps.prisma.position.update({ where: { id: positionId }, data: { takeProfitPercent: n } });
  return { ok: true, result: await renderPositions(deps, user) };
}

export async function applyStopLoss(
  deps: ScreenDeps,
  user: ScreenUser,
  positionId: string,
  raw: string,
): Promise<{ ok: true; result: ScreenResult } | { ok: false; message: string }> {
  const n = Number(raw.trim());
  if (!Number.isFinite(n) || n <= 0) {
    return { ok: false, message: "That doesn't look right — send a positive number." };
  }
  const position = await loadOwnedPosition(deps, user, positionId);
  if (!position) return { ok: false, message: 'That position no longer exists.' };

  await deps.prisma.position.update({ where: { id: positionId }, data: { stopLossPercent: n } });
  return { ok: true, result: await renderPositions(deps, user) };
}
