import { InlineKeyboard } from 'grammy';
import { withNav } from '../keyboards.js';
import { sol } from '../format.js';
import type { PendingAction } from '../pending.js';
import type { ScreenDeps, ScreenResult, ScreenUser } from '../types.js';

type SettingsField = Extract<PendingAction, { type: 'settings_edit' }>['field'];

const FIELD_META: Record<
  SettingsField,
  { label: string; prompt: string; parse: (raw: string) => number | undefined }
> = {
  buyAmountSol: {
    label: 'Buy amount',
    prompt: 'Send the new buy amount in SOL (e.g. `0.25`).',
    parse: (raw) => {
      const n = Number(raw);
      return Number.isFinite(n) && n > 0 ? n : undefined;
    },
  },
  maxSlippageBps: {
    label: 'Max slippage',
    prompt: 'Send the new max slippage in basis points, 1-10000 (e.g. `300` for 3%).',
    parse: (raw) => {
      const n = Number(raw);
      return Number.isInteger(n) && n >= 1 && n <= 10000 ? n : undefined;
    },
  },
  minLiquidityUsd: {
    label: 'Min liquidity',
    prompt: 'Send the new minimum liquidity in USD (e.g. `1000`).',
    parse: (raw) => {
      const n = Number(raw);
      return Number.isFinite(n) && n >= 0 ? n : undefined;
    },
  },
  minAiScore: {
    label: 'Min AI score',
    prompt: 'Send the new minimum AI score, 0-100 (e.g. `60`).',
    parse: (raw) => {
      const n = Number(raw);
      return Number.isFinite(n) && n >= 0 && n <= 100 ? n : undefined;
    },
  },
};

export async function renderSettings(deps: ScreenDeps, user: ScreenUser): Promise<ScreenResult> {
  const config = await deps.prisma.snipeConfig.findFirst({
    where: { userId: user.id },
    orderBy: { createdAt: 'desc' },
  });

  if (!config) {
    return {
      text: '⚙️ *Settings*\n\nYou have no snipe config yet — create one from ▶️ Start Sniper first, then come back here to fine-tune it.',
      keyboard: withNav(new InlineKeyboard(), 'home'),
    };
  }

  const text =
    `⚙️ *Settings*\n\n` +
    `Editing your most recent snipe config:\n\n` +
    `💰 Buy amount: *${sol(config.buyAmountSol)}*\n` +
    `📉 Max slippage: *${config.maxSlippageBps} bps*\n` +
    `💧 Min liquidity: *$${config.minLiquidityUsd.toFixed(0)}*\n` +
    `🤖 Min AI score: *${config.minAiScore}*`;

  const keyboard = new InlineKeyboard()
    .text('✏️ Buy amount', `a:settings:edit:buyAmountSol:${config.id}`)
    .text('✏️ Slippage', `a:settings:edit:maxSlippageBps:${config.id}`)
    .row()
    .text('✏️ Min liquidity', `a:settings:edit:minLiquidityUsd:${config.id}`)
    .text('✏️ Min AI score', `a:settings:edit:minAiScore:${config.id}`);

  return { text, keyboard: withNav(keyboard, 'home') };
}

export function isSettingsField(value: string): value is SettingsField {
  return value in FIELD_META;
}

export function promptFor(field: SettingsField): ScreenResult {
  return {
    text: `⚙️ *${FIELD_META[field].label}*\n\n${FIELD_META[field].prompt}`,
    keyboard: withNav(new InlineKeyboard(), 'settings'),
  };
}

export async function applySettingsEdit(
  deps: ScreenDeps,
  user: ScreenUser,
  snipeConfigId: string,
  field: SettingsField,
  rawValue: string,
): Promise<{ ok: true; result: ScreenResult } | { ok: false; message: string }> {
  const parsed = FIELD_META[field].parse(rawValue.trim());
  if (parsed === undefined) {
    return { ok: false, message: `That doesn't look right. ${FIELD_META[field].prompt}` };
  }

  const config = await deps.prisma.snipeConfig.findUnique({ where: { id: snipeConfigId } });
  if (!config || config.userId !== user.id) {
    return { ok: false, message: 'That snipe config no longer exists.' };
  }

  await deps.prisma.snipeConfig.update({
    where: { id: snipeConfigId },
    data: { [field]: parsed },
  });

  return { ok: true, result: await renderSettings(deps, user) };
}
