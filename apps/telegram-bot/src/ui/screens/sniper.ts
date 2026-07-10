import { InlineKeyboard } from 'grammy';
import { withNav } from '../keyboards.js';
import { sol } from '../format.js';
import type { ScreenDeps, ScreenResult, ScreenUser } from '../types.js';

const DEFAULT_BUY_AMOUNT_SOL = 0.1;

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
    text += configs.map(formatConfig).join('\n');
    const anyPaused = configs.some((c) => !c.isActive);
    if (anyPaused) {
      keyboard.text('▶️ Resume All', 'a:sniper:resumeall').row();
    }
    keyboard.text('➕ Add Another Config (0.1 SOL)', 'a:sniper:quickstart');
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
