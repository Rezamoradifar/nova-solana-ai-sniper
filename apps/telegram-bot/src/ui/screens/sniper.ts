import { InlineKeyboard } from 'grammy';
import type { SnipeConfig, Wallet } from '@prisma/client';
import { MAX_SNIPE_CONFIGS_PER_USER } from '@nova/shared';
import { withNav } from '../keyboards.js';
import { sol, shortKey, escapeMd } from '../format.js';
import { hasAcceptedCurrentFeePolicy, renderFeePolicyConsent } from './feePolicyConsent.js';
import { getLocale, t } from '../../i18n/index.js';
import type { ScreenDeps, ScreenResult, ScreenUser } from '../types.js';

const DEFAULT_BUY_AMOUNT_SOL = 0.1;

// Telegram rejects a sendMessage whose text exceeds 4096 chars and a keyboard
// with more than 100 buttons outright — cap how many configs this screen ever
// renders with full per-config controls so a user who's at (or, for pre-cap
// rows created before MAX_SNIPE_CONFIGS_PER_USER existed, well above) the
// limit never gets a hard failure that locks them out of the screen entirely.
const MAX_RENDERED_CONFIGS = 15;

/** The wallet AutoTrader will actually buy from for this config (see
 * autoTrader.ts's own identical fallback) — a config pinned to a still-active
 * wallet (walletId set) uses it; everyone else (including every config that
 * predates this field) falls back to the user's first active wallet. Kept in
 * sync with autoTrader.ts's selection logic so the label shown here is never
 * a guess. */
function resolveConfigWallet(
  config: Pick<SnipeConfig, 'walletId'>,
  activeWallets: Wallet[],
): Wallet | undefined {
  if (config.walletId) {
    return activeWallets.find((w) => w.id === config.walletId) ?? activeWallets[0];
  }
  return activeWallets[0];
}

function walletLabel(wallet: Wallet | undefined, d: ReturnType<typeof t>['sniper']): string {
  if (!wallet) return d.noActiveWallet;
  return wallet.label ? escapeMd(wallet.label) : shortKey(wallet.publicKey);
}

function formatConfigCard(
  config: SnipeConfig,
  index: number,
  activeWallets: Wallet[],
  d: ReturnType<typeof t>['sniper'],
): string {
  const wallet = resolveConfigWallet(config, activeWallets);
  return d.card(
    index,
    walletLabel(wallet, d),
    sol(config.buyAmountSol),
    config.minAiScore,
    config.autoBuyOnLaunch ? d.on : d.off,
    config.isActive ? d.active : d.paused,
  );
}

async function loadConfigsAndWallets(deps: ScreenDeps, user: ScreenUser) {
  const [configs, activeWallets] = await Promise.all([
    deps.prisma.snipeConfig.findMany({
      where: { userId: user.id },
      // Ascending so a config's displayed number stays stable across renders
      // (pausing/resuming/adding another config never reshuffles #1, #2, ...).
      orderBy: { createdAt: 'asc' },
    }),
    deps.prisma.wallet.findMany({
      where: { userId: user.id, isActive: true },
      orderBy: { createdAt: 'asc' },
    }),
  ]);
  return { configs, activeWallets };
}

export async function renderSniperStart(deps: ScreenDeps, user: ScreenUser): Promise<ScreenResult> {
  // Require explicit acceptance of the current performance-fee/referral policy
  // before any auto-trading can be enabled — see feePolicyConsent.ts. Already-
  // accepted users (the common case once this ships) see zero change below.
  if (!(await hasAcceptedCurrentFeePolicy(deps, user))) {
    return renderFeePolicyConsent(deps, user);
  }

  const lang = getLocale(user);
  const d = t(lang).sniper;
  const { configs, activeWallets } = await loadConfigsAndWallets(deps, user);

  const keyboard = new InlineKeyboard();
  let text = d.startTitle;

  if (configs.length === 0) {
    text += d.noConfigText;
    keyboard.text(d.quickStartBtn, 'a:sniper:quickstart');
    return { text, keyboard: withNav(keyboard, 'home', lang) };
  }

  const shown = configs.slice(0, MAX_RENDERED_CONFIGS);
  text += shown.map((c, i) => formatConfigCard(c, i + 1, activeWallets, d)).join('\n\n');
  if (configs.length > shown.length) {
    text += d.moreNote(configs.length - shown.length);
  }

  for (const config of shown) {
    if (config.isActive) {
      keyboard.text(d.pauseBtn, `a:sniper:pause:${config.id}`);
    } else {
      keyboard.text(d.resumeBtn, `a:sniper:resume:${config.id}`);
    }
    keyboard.text(d.deleteConfigBtn, `a:sniper:delask:${config.id}`).row();
  }

  const anyPaused = configs.some((c) => !c.isActive);
  if (anyPaused) {
    keyboard.text(d.resumeAllBtn, 'a:sniper:resumeall').row();
  }
  if (configs.length < MAX_SNIPE_CONFIGS_PER_USER) {
    keyboard.text(d.addAnotherBtn, 'a:sniper:quickstart').row();
  }

  return { text, keyboard: withNav(keyboard, 'home', lang) };
}

/** "Stop Sniper" now asks what the user actually wants rather than pausing
 * blind — see the task's own UX spec: pausing auto-buy must never leave a
 * user unsure about their still-open positions. */
export async function renderSniperStop(deps: ScreenDeps, user: ScreenUser): Promise<ScreenResult> {
  const lang = getLocale(user);
  const d = t(lang).sniper;
  const activeCount = await deps.prisma.snipeConfig.count({
    where: { userId: user.id, isActive: true },
  });

  const text = d.stopTitle + (activeCount > 0 ? d.activeNote(activeCount) : d.nothingActive);

  const keyboard = new InlineKeyboard();
  if (activeCount > 0) {
    keyboard.text(d.pauseAllBtn, 'a:sniper:pauseall').row();
  }
  keyboard.text(d.selectConfigBtn, 'a:sniper:selectconfig').row();
  keyboard.text(d.cancelBtn, 's:home');

  return { text, keyboard };
}

/** Shown once after Pause All actually runs — points the user at the two
 * things they might reasonably want to do next about positions that are
 * still open and still being monitored. */
function renderPausedConfirmation(
  pausedCount: number,
  lang: ReturnType<typeof getLocale>,
): ScreenResult {
  const d = t(lang).sniper;
  const text = d.pausedConfirmation(pausedCount);
  const keyboard = new InlineKeyboard()
    .text(d.openPositionsBtn, 's:positions')
    .row()
    .text(d.closeAllPositionsBtn, 'a:positions:closeallask')
    .row()
    .text(d.homeBtn, 's:home');
  return { text, keyboard };
}

export async function handleQuickStart(deps: ScreenDeps, user: ScreenUser): Promise<ScreenResult> {
  // Defense in depth: renderSniperStart already hides this button unless the fee
  // policy has been accepted, but an old message/replayed callback could still
  // reach here directly — re-check server-side, same convention as the
  // existingCount re-check right below.
  if (!(await hasAcceptedCurrentFeePolicy(deps, user))) {
    return renderFeePolicyConsent(deps, user);
  }

  // Defense in depth: renderSniperStart already hides this button at the cap, but
  // an old Telegram message (or a double-tap already in flight) can still replay
  // this callback, so re-check server-side rather than trusting the button state.
  const existingCount = await deps.prisma.snipeConfig.count({ where: { userId: user.id } });
  if (existingCount >= MAX_SNIPE_CONFIGS_PER_USER) {
    return renderSniperStart(deps, user);
  }

  // Stamped so this config has a concrete, displayable wallet from day one —
  // exactly the wallet AutoTrader would pick anyway (its own no-walletId
  // fallback is the user's first active wallet), so this changes nothing about
  // which wallet actually buys, only what this screen can show for it.
  const firstActiveWallet = await deps.prisma.wallet.findFirst({
    where: { userId: user.id, isActive: true },
    orderBy: { createdAt: 'asc' },
  });

  await deps.prisma.snipeConfig.create({
    data: {
      userId: user.id,
      walletId: firstActiveWallet?.id,
      buyAmountSol: DEFAULT_BUY_AMOUNT_SOL,
      autoBuyOnLaunch: true,
      isActive: true,
    },
  });
  return renderSniperStart(deps, user);
}

export async function handleResumeAll(deps: ScreenDeps, user: ScreenUser): Promise<ScreenResult> {
  if (!(await hasAcceptedCurrentFeePolicy(deps, user))) {
    return renderFeePolicyConsent(deps, user);
  }

  await deps.prisma.snipeConfig.updateMany({
    where: { userId: user.id },
    data: { isActive: true },
  });
  return renderSniperStart(deps, user);
}

/** Pauses every active SnipeConfig belonging ONLY to this Telegram user —
 * server-side scoped by user.id (never trusts callback_data), so this can
 * never affect another user's configs. Returns how many were actually paused. */
export async function handlePauseAll(deps: ScreenDeps, user: ScreenUser): Promise<ScreenResult> {
  const result = await deps.prisma.snipeConfig.updateMany({
    where: { userId: user.id, isActive: true },
    data: { isActive: false },
  });
  return renderPausedConfirmation(result.count, getLocale(user));
}

/** "Select Config" from the Stop Sniper screen — the Start Sniper screen
 * already has the exact per-config Pause/Resume/Delete controls needed here,
 * so this just navigates there instead of building a second, parallel list. */
export async function handleSelectConfig(
  deps: ScreenDeps,
  user: ScreenUser,
): Promise<ScreenResult> {
  return renderSniperStart(deps, user);
}

/** Ownership check shared by every per-config action below — never trusts the
 * config id from callback_data alone; a config only loads if it actually
 * belongs to the resolved Telegram user. */
async function loadOwnedConfig(deps: ScreenDeps, user: ScreenUser, configId: string) {
  const config = await deps.prisma.snipeConfig.findUnique({ where: { id: configId } });
  return config && config.userId === user.id ? config : null;
}

export async function handlePauseConfig(
  deps: ScreenDeps,
  user: ScreenUser,
  configId: string,
): Promise<ScreenResult> {
  const config = await loadOwnedConfig(deps, user, configId);
  if (!config) return renderSniperStart(deps, user);
  await deps.prisma.snipeConfig.update({ where: { id: config.id }, data: { isActive: false } });
  return renderSniperStart(deps, user);
}

export async function handleResumeConfig(
  deps: ScreenDeps,
  user: ScreenUser,
  configId: string,
): Promise<ScreenResult> {
  if (!(await hasAcceptedCurrentFeePolicy(deps, user))) {
    return renderFeePolicyConsent(deps, user);
  }
  const config = await loadOwnedConfig(deps, user, configId);
  if (!config) return renderSniperStart(deps, user);
  await deps.prisma.snipeConfig.update({ where: { id: config.id }, data: { isActive: true } });
  return renderSniperStart(deps, user);
}

export async function renderDeleteConfigConfirm(
  deps: ScreenDeps,
  user: ScreenUser,
  configId: string,
): Promise<ScreenResult> {
  const lang = getLocale(user);
  const d = t(lang).sniper;
  const config = await loadOwnedConfig(deps, user, configId);
  if (!config) return renderSniperStart(deps, user);

  const text = d.deleteConfirmTitle + d.deleteConfirmBody;
  const keyboard = new InlineKeyboard()
    .text(d.confirmDeleteBtn, `a:sniper:del:${config.id}`)
    .row()
    .text(d.cancelBtn, 's:sniper_start');
  return { text, keyboard };
}

/** Deletes ONLY the SnipeConfig row — never the wallet, never any Position,
 * never any Trade/PnL/ledger history. Re-verifies ownership server-side
 * (never trusts the id from callback_data alone) and is a no-op (not an
 * error) if the config was already deleted by a prior tap. */
export async function handleDeleteConfig(
  deps: ScreenDeps,
  user: ScreenUser,
  configId: string,
): Promise<ScreenResult> {
  const config = await loadOwnedConfig(deps, user, configId);
  if (config) {
    await deps.prisma.snipeConfig.delete({ where: { id: config.id } });
  }
  return renderSniperStart(deps, user);
}
