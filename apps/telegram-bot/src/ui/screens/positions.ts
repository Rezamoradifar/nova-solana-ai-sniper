import { InlineKeyboard } from 'grammy';
import { withNav } from '../keyboards.js';
import { sol, usd, pnlEmoji, shortKey, escapeMd } from '../format.js';
import {
  fetchPositions,
  closePositionApi,
  closeAllPositionsApi,
  ApiRequestError,
  type ApiPosition,
} from '../../api/client.js';
import { getLocale, normalizeDigits, t, type Locale } from '../../i18n/index.js';
import type { ScreenDeps, ScreenResult, ScreenUser } from '../types.js';

const PAGE_SIZE = 5;

// Cheap UX-layer duplicate-tap guards, module-level and process-lifetime only —
// the authoritative guard against a genuine duplicate close is apps/api's own
// DB-backed positionCloseLock (see positionCloseLock.ts), shared by every
// caller of PositionManager.closePosition. Losing these on a bot restart just
// means a double-tap right at that moment falls through to the server's lock
// instead of being caught a moment earlier here — never unsafe, just slightly
// less snappy feedback.
const inFlightCloses = new Set<string>();
const inFlightCloseAll = new Set<string>();

function friendlySellFailureReason(
  message: string,
  category: string | undefined,
  lang: Locale,
): string {
  const r = t(lang).positions.friendlyReasons;
  switch (category) {
    case 'route_unavailable':
      return r.routeUnavailable;
    case 'liquidity':
      return r.liquidity;
    case 'slippage':
      return r.slippage;
    case 'blockhash_expired':
    case 'confirmation_timeout':
    case 'rpc_timeout':
      return r.networkSlow;
    case 'position_lock':
      return r.positionLock;
    default:
      return message;
  }
}

function formatOpenPosition(
  p: ApiPosition,
  walletLabelById: Map<string, string>,
  d: ReturnType<typeof t>['positions'],
): string {
  const symbol = escapeMd(p.token.symbol ?? p.token.mint.slice(0, 6));
  const wallet = walletLabelById.get(p.walletId) ?? shortKey(p.walletId);
  const remaining = (p.remainingAmountToken ?? p.amountToken) / 10 ** p.token.decimals;

  const lines = [
    d.positionHeader(symbol, shortKey(p.token.mint)),
    d.walletLine(wallet),
    d.buyEntryLine(sol(p.amountSolInvested), p.entryPriceUsd.toFixed(8)),
  ];

  if (p.currentPriceUsd != null) {
    const estValue = p.currentPriceUsd * remaining;
    const pnlPercent =
      p.entryPriceUsd > 0 ? ((p.currentPriceUsd - p.entryPriceUsd) / p.entryPriceUsd) * 100 : 0;
    lines.push(d.currentValueLine(usd(estValue), pnlEmoji(pnlPercent), pnlPercent.toFixed(2)));
  } else {
    lines.push(d.currentValueUnavailable);
  }
  lines.push(d.tokenBalance(remaining.toFixed(4)));
  lines.push(d.statusOpen);
  return lines.join('\n');
}

/**
 * "📊 Open Positions" (task C) — queries only OPEN positions belonging to
 * wallets owned by the authenticated Telegram user, enriched with a live
 * price/unrealized-PnL via apps/api's own GET /positions (the exact same
 * enrichment the Mini App/dashboard already use — never re-derived here).
 * Paginated so a user with many open positions never hits Telegram's
 * message/button limits.
 */
export async function renderPositions(
  deps: ScreenDeps,
  user: ScreenUser,
  page = 0,
): Promise<ScreenResult> {
  const lang = getLocale(user);
  const d = t(lang).positions;

  if (!deps.api) {
    return {
      text: d.notConfigured,
      keyboard: withNav(new InlineKeyboard(), 'home', lang),
    };
  }

  const closedCount = await deps.prisma.position.count({
    where: { status: 'CLOSED', wallet: { userId: user.id } },
  });

  let apiPositions: ApiPosition[];
  try {
    apiPositions = await fetchPositions(deps.api, user);
  } catch (err) {
    deps.logger.error({ err }, 'positions: failed to fetch enriched positions from apps/api');
    return {
      text: d.loadFailed,
      keyboard: withNav(new InlineKeyboard(), 'home', lang),
    };
  }

  const open = apiPositions
    .filter((p) => p.status === 'OPEN')
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  const wallets = await deps.prisma.wallet.findMany({ where: { userId: user.id } });
  const walletLabelById = new Map(
    wallets.map((w) => [w.id, w.label ? escapeMd(w.label) : shortKey(w.publicKey)]),
  );

  let text = d.title;
  const keyboard = new InlineKeyboard();

  if (open.length === 0) {
    text += d.empty;
  } else {
    const totalPages = Math.max(1, Math.ceil(open.length / PAGE_SIZE));
    const clampedPage = Math.min(Math.max(page, 0), totalPages - 1);
    const shown = open.slice(clampedPage * PAGE_SIZE, clampedPage * PAGE_SIZE + PAGE_SIZE);

    text += shown.map((p) => formatOpenPosition(p, walletLabelById, d)).join('\n\n');
    if (totalPages > 1) {
      text += d.pageLabel(clampedPage + 1, totalPages);
    }

    for (const p of shown) {
      const symbol = p.token.symbol ?? p.token.mint.slice(0, 6);
      keyboard
        .text(d.tpBtn(symbol), `a:positions:edittp:${p.id}`)
        .text(d.slBtn(symbol), `a:positions:editsl:${p.id}`)
        .row()
        .text(d.closePositionBtn, `a:positions:closeask:${p.id}`)
        .url(d.explorerBtn, `https://solscan.io/token/${p.token.mint}`)
        .row();
    }

    if (totalPages > 1) {
      if (clampedPage > 0) keyboard.text(d.prevBtn, `a:positions:page:${clampedPage - 1}`);
      if (clampedPage < totalPages - 1)
        keyboard.text(d.nextBtn, `a:positions:page:${clampedPage + 1}`);
      keyboard.row();
    }

    keyboard.text(d.closeAllBtn, 'a:positions:closeallask').row();
  }

  text += d.closedCountLine(closedCount);

  return { text, keyboard: withNav(keyboard, 'home', lang) };
}

export function renderPositionsPage(
  deps: ScreenDeps,
  user: ScreenUser,
  page: number,
): Promise<ScreenResult> {
  return renderPositions(deps, user, page);
}

// --- Manual close: single position (task D) --------------------------------

function renderClosePositionConfirm(
  positionId: string,
  symbol: string,
  lang: Locale,
): ScreenResult {
  const d = t(lang).positions;
  const text = d.confirmCloseTitle(escapeMd(symbol)) + d.confirmCloseBody;
  const keyboard = new InlineKeyboard()
    .text(d.confirmSellBtn, `a:positions:close:${positionId}`)
    .row()
    .text(d.cancelBtn, 's:positions');
  return { text, keyboard };
}

/** Ownership + OPEN check, shared by every position action below — never
 * trusts the position id from callback_data alone. */
async function loadOwnedOpenPositionForClose(
  deps: ScreenDeps,
  user: ScreenUser,
  positionId: string,
) {
  const position = await deps.prisma.position.findUnique({
    where: { id: positionId },
    include: { token: true, wallet: true },
  });
  if (!position || position.wallet.userId !== user.id) return { error: 'not_found' as const };
  if (position.status !== 'OPEN') return { error: 'not_open' as const };
  return { position };
}

export async function handleClosePositionAsk(
  deps: ScreenDeps,
  user: ScreenUser,
  positionId: string,
): Promise<ScreenResult> {
  const loaded = await loadOwnedOpenPositionForClose(deps, user, positionId);
  if ('error' in loaded) return renderPositions(deps, user);
  const symbol = loaded.position.token.symbol ?? loaded.position.token.mint.slice(0, 6);
  return renderClosePositionConfirm(loaded.position.id, symbol, getLocale(user));
}

export async function handleClosePositionConfirm(
  deps: ScreenDeps,
  user: ScreenUser,
  positionId: string,
): Promise<ScreenResult> {
  const lang = getLocale(user);
  const d = t(lang).positions;

  if (!deps.api) {
    return {
      text: d.notConfiguredShort,
      keyboard: withNav(new InlineKeyboard(), 'positions', lang),
    };
  }
  // Checked and set synchronously (no `await` in between) so two near-
  // simultaneous taps can never both pass this guard — the second call's
  // `has` always observes the first call's `add`, since nothing yields
  // control to it in between. This is the UX-layer half of duplicate-close
  // prevention; apps/api's own DB-backed positionCloseLock is the
  // authoritative guard underneath it.
  if (inFlightCloses.has(positionId)) {
    return {
      text: d.alreadyProcessing,
      keyboard: withNav(new InlineKeyboard(), 'positions', lang),
    };
  }
  inFlightCloses.add(positionId);

  try {
    const loaded = await loadOwnedOpenPositionForClose(deps, user, positionId);
    if ('error' in loaded) {
      return {
        text: loaded.error === 'not_found' ? d.positionGoneOrNotYours : d.alreadyClosed,
        keyboard: withNav(new InlineKeyboard(), 'positions', lang),
      };
    }
    const { position } = loaded;
    const symbol = position.token.symbol ?? position.token.mint.slice(0, 6);

    const result = await closePositionApi(deps.api, user, positionId);

    if (result.signature === null) {
      if (!result.closed) {
        return {
          text: d.alreadyHandled,
          keyboard: withNav(new InlineKeyboard(), 'positions', lang),
        };
      }
      // Task F: zero-balance reconciliation — closePosition confirmed the
      // wallet holds 0 of this token on-chain, so no swap was attempted and
      // no PnL was fabricated. See positionManager.ts's closePositionLocked.
      return {
        text: d.zeroBalanceReconciliation(escapeMd(symbol)),
        keyboard: withNav(new InlineKeyboard(), 'positions', lang),
      };
    }

    const pnl = result.position.realizedPnlUsd;
    const text =
      d.closedSuccess(escapeMd(symbol)) +
      (pnl != null ? d.realizedPnlLine(pnlEmoji(pnl), usd(pnl)) : '') +
      d.txLine(result.signature);
    return { text, keyboard: withNav(new InlineKeyboard(), 'positions', lang) };
  } catch (err) {
    const message =
      err instanceof ApiRequestError
        ? friendlySellFailureReason(err.message, err.category, lang)
        : d.unexpectedCloseError;
    deps.logger.error({ err, positionId }, 'positions: manual close failed');
    return {
      text: d.closeFailedTitle(escapeMd(message)),
      keyboard: withNav(new InlineKeyboard(), 'positions', lang),
    };
  } finally {
    inFlightCloses.delete(positionId);
  }
}

// --- Manual close: all positions (task E) -----------------------------------

function renderCloseAllConfirm(lang: Locale): ScreenResult {
  const d = t(lang).positions;
  const text = d.closeAllConfirmTitle + d.closeAllConfirmBody;
  const keyboard = new InlineKeyboard()
    .text(d.confirmCloseAllBtn, 'a:positions:closeallconfirm')
    .row()
    .text(d.cancelBtn, 's:positions');
  return { text, keyboard };
}

export function handleCloseAllAsk(lang: Locale): ScreenResult {
  return renderCloseAllConfirm(lang);
}

export async function handleCloseAllConfirm(
  deps: ScreenDeps,
  user: ScreenUser,
): Promise<ScreenResult> {
  const lang = getLocale(user);
  const d = t(lang).positions;

  if (!deps.api) {
    return {
      text: d.notConfiguredShort,
      keyboard: withNav(new InlineKeyboard(), 'positions', lang),
    };
  }
  if (inFlightCloseAll.has(user.id)) {
    return {
      text: d.alreadyProcessingCloseAll,
      keyboard: withNav(new InlineKeyboard(), 'positions', lang),
    };
  }

  inFlightCloseAll.add(user.id);
  try {
    const result = await closeAllPositionsApi(deps.api, user);

    let text = d.closeAllSummaryTitle(result.closed, result.failed, result.skipped);
    if (result.failures.length > 0) {
      const shown = result.failures.slice(0, 10);
      text += `\n\n${shown.map((f) => d.failureRow(escapeMd(f.symbol), escapeMd(f.reason))).join('\n')}`;
      if (result.failures.length > shown.length) {
        text += d.moreFailures(result.failures.length - shown.length);
      }
    }
    return { text, keyboard: withNav(new InlineKeyboard(), 'positions', lang) };
  } catch (err) {
    const message = err instanceof ApiRequestError ? err.message : d.unexpectedCloseAllError;
    deps.logger.error({ err, userId: user.id }, 'positions: close-all failed');
    return {
      text: d.closeAllFailedTitle(escapeMd(message)),
      keyboard: withNav(new InlineKeyboard(), 'positions', lang),
    };
  } finally {
    inFlightCloseAll.delete(user.id);
  }
}

// --- Existing manual TP/SL editing (unchanged — plain field updates, no
// trading-engine call needed) -------------------------------------------------

export function takeProfitPrompt(lang: Locale): ScreenResult {
  return {
    text: t(lang).positions.tpPromptTitle,
    keyboard: withNav(new InlineKeyboard(), 'positions', lang),
  };
}

export function stopLossPrompt(lang: Locale): ScreenResult {
  return {
    text: t(lang).positions.slPromptTitle,
    keyboard: withNav(new InlineKeyboard(), 'positions', lang),
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
  const lang = getLocale(user);
  const d = t(lang).positions;
  const n = Number(normalizeDigits(raw.trim()));
  if (!Number.isFinite(n) || n <= 0) {
    return { ok: false, message: d.invalidNumber };
  }
  const position = await loadOwnedPosition(deps, user, positionId);
  if (!position) return { ok: false, message: d.positionGone };

  await deps.prisma.position.update({ where: { id: positionId }, data: { takeProfitPercent: n } });
  return { ok: true, result: await renderPositions(deps, user) };
}

export async function applyStopLoss(
  deps: ScreenDeps,
  user: ScreenUser,
  positionId: string,
  raw: string,
): Promise<{ ok: true; result: ScreenResult } | { ok: false; message: string }> {
  const lang = getLocale(user);
  const d = t(lang).positions;
  const n = Number(normalizeDigits(raw.trim()));
  if (!Number.isFinite(n) || n <= 0) {
    return { ok: false, message: d.invalidNumber };
  }
  const position = await loadOwnedPosition(deps, user, positionId);
  if (!position) return { ok: false, message: d.positionGone };

  await deps.prisma.position.update({ where: { id: positionId }, data: { stopLossPercent: n } });
  return { ok: true, result: await renderPositions(deps, user) };
}
