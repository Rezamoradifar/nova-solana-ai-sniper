import { InlineKeyboard } from 'grammy';
import { MAX_SNIPE_CONFIGS_PER_USER } from '@nova/shared';
import { withNav } from '../keyboards.js';
import { sol } from '../format.js';
import type { ScreenDeps, ScreenResult, ScreenUser } from '../types.js';

const DEFAULT_BUY_AMOUNT_SOL = 0.1;

// Telegram rejects a sendMessage whose text exceeds 4096 chars outright — cap how
// many config lines this screen ever renders so a user who's at (or, for pre-cap
// rows created before MAX_SNIPE_CONFIGS_PER_USER existed, well above) the limit
// never gets a hard "message is too long" failure that locks them out of the
// screen entirely.
const MAX_RENDERED_CONFIG_LINES = 20;

function formatConfig(c: {
  buyAmountSol: number;
  isActive: boolean;
  autoBuyOnLaunch: boolean;
  minAiScore: number;
}): string {
  const status = c.isActive ? '🟢 active' : '⏸ paused';
  const autoBuy = c.autoBuyOnLaunch ? 'auto-buy on launch' : 'manual only';
  return `${status} — ${sol(c.buyAmountSol)} · min AI score ${c.minAiScore} · ${autoBuy}`;
}

export async function renderSniperStart(deps: ScreenDeps, user: ScreenUser): Promise<ScreenResult> {
  const configs = await deps.prisma.snipeConfig.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: 'desc' },
  });

  const keyboard = new InlineKeyboard();
  let text = '▶️ *Start Sniper*\n\n';

  if (configs.length === 0) {
    text +=
      'No snipe config yet.\n\nQuick-start creates a default auto-buy config you can fine-tune later in Settings.';
    keyboard.text('➕ Quick Start (0.1 SOL)', 'a:sniper:quickstart');
  } else {
    const shown = configs.slice(0, MAX_RENDERED_CONFIG_LINES);
    text += shown.map(formatConfig).join('\n');
    if (configs.length > shown.length) {
      text += `\n… and ${configs.length - shown.length} more (contact support to clean these up).`;
    }
    const anyPaused = configs.some((c) => !c.isActive);
    if (anyPaused) {
      keyboard.text('▶️ Resume All', 'a:sniper:resumeall').row();
    }
    if (configs.length < MAX_SNIPE_CONFIGS_PER_USER) {
      keyboard.text('➕ Add Another Config (0.1 SOL)', 'a:sniper:quickstart');
    }
  }

  return { text, keyboard: withNav(keyboard, 'home') };
}

export async function renderSniperStop(deps: ScreenDeps, user: ScreenUser): Promise<ScreenResult> {
  const [activeCount, totalCount] = await Promise.all([
    deps.prisma.snipeConfig.count({ where: { userId: user.id, isActive: true } }),
    deps.prisma.snipeConfig.count({ where: { userId: user.id } }),
  ]);

  const text =
    `⏹ *Stop Sniper*\n\n` +
    `${activeCount} of ${totalCount} snipe config(s) currently active.\n\n` +
    (activeCount > 0
      ? 'Stopping does not delete your configs — it just pauses auto-buying.'
      : 'Nothing is currently running.');

  const keyboard = new InlineKeyboard();
  if (activeCount > 0) {
    keyboard.text('⏹ Stop All', 'a:sniper:stopall');
  }

  return { text, keyboard: withNav(keyboard, 'home') };
}

export async function handleQuickStart(deps: ScreenDeps, user: ScreenUser): Promise<ScreenResult> {
  // Defense in depth: renderSniperStart already hides this button at the cap, but
  // an old Telegram message (or a double-tap already in flight) can still replay
  // this callback, so re-check server-side rather than trusting the button state.
  const existingCount = await deps.prisma.snipeConfig.count({ where: { userId: user.id } });
  if (existingCount >= MAX_SNIPE_CONFIGS_PER_USER) {
    return renderSniperStart(deps, user);
  }

  await deps.prisma.snipeConfig.create({
    data: {
      userId: user.id,
      buyAmountSol: DEFAULT_BUY_AMOUNT_SOL,
      autoBuyOnLaunch: true,
      isActive: true,
    },
  });
  return renderSniperStart(deps, user);
}

export async function handleResumeAll(deps: ScreenDeps, user: ScreenUser): Promise<ScreenResult> {
  await deps.prisma.snipeConfig.updateMany({
    where: { userId: user.id },
    data: { isActive: true },
  });
  return renderSniperStart(deps, user);
}

export async function handleStopAll(deps: ScreenDeps, user: ScreenUser): Promise<ScreenResult> {
  await deps.prisma.snipeConfig.updateMany({
    where: { userId: user.id },
    data: { isActive: false },
  });
  return renderSniperStop(deps, user);
}
