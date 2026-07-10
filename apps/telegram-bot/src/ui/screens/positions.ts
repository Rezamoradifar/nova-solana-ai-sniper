import { InlineKeyboard } from 'grammy';
import { withNav } from '../keyboards.js';
import { sol, escapeMd } from '../format.js';
import type { ScreenDeps, ScreenResult, ScreenUser } from '../types.js';

const MAX_SHOWN = 8;

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
    text += open
      .map((p) => {
        const symbol = escapeMd(p.token.symbol ?? p.token.mint.slice(0, 6));
        const tp = p.takeProfitPercent ? `TP ${p.takeProfitPercent}%` : 'TP —';
        const sl = p.stopLossPercent ? `SL ${p.stopLossPercent}%` : 'SL —';
        return `🪙 ${symbol} — ${sol(p.amountSolInvested)} invested\n${tp} · ${sl}`;
      })
      .join('\n\n');

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
