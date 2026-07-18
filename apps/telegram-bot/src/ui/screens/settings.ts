import { InlineKeyboard } from 'grammy';
import {
  TRAILING_STOP_PRESETS,
  TRAILING_STOP_PRESET_LABELS,
  DEFAULT_MAX_LOSS_PERCENT,
} from '@nova/shared';
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
  // Hard Loss Ceiling (2026-07-18): a user may set a tighter stop loss than
  // DEFAULT_MAX_LOSS_PERCENT, but never a looser one — PositionManager
  // enforces this again at buy time regardless (see exitEngine.ts's
  // resolveEffectiveStopLossPercent), so a value entered here that exceeds
  // the ceiling would silently diverge from what actually protects the
  // position; capping it here too keeps what the user sees consistent with
  // what's actually enforced.
  stopLossPercent: {
    label: 'Stop loss',
    prompt: `Send the new stop-loss percentage as a number (e.g. \`15\` for -15%). Never honored looser than ${DEFAULT_MAX_LOSS_PERCENT}% — a larger value is capped to ${DEFAULT_MAX_LOSS_PERCENT}.`,
    parse: (raw) => {
      const n = Number(raw);
      return Number.isFinite(n) && n > 0 ? Math.min(n, DEFAULT_MAX_LOSS_PERCENT) : undefined;
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

  const presetLabel = isKnownPreset(config.trailingStopPreset)
    ? TRAILING_STOP_PRESET_LABELS[config.trailingStopPreset]
    : 'Custom (manual TP/SL/trailing on each position)';

  // A SnipeConfig with no stopLossPercent set (or one looser than the
  // ceiling) still gets DEFAULT_MAX_LOSS_PERCENT enforced at buy time — see
  // exitEngine.ts's resolveEffectiveStopLossPercent — this just reflects that
  // truthfully rather than showing a blank/unset field.
  const effectiveStopLossPercent = Math.min(
    config.stopLossPercent ?? DEFAULT_MAX_LOSS_PERCENT,
    DEFAULT_MAX_LOSS_PERCENT,
  );
  const stopLossLine =
    config.stopLossPercent != null && config.stopLossPercent <= DEFAULT_MAX_LOSS_PERCENT
      ? `🛑 Stop loss: *${effectiveStopLossPercent}%*`
      : `🛑 Stop loss: *${effectiveStopLossPercent}%* _(system default — never looser than ${DEFAULT_MAX_LOSS_PERCENT}%)_`;

  const text =
    `⚙️ *Settings*\n\n` +
    `Editing your most recent snipe config:\n\n` +
    `💰 Buy amount: *${sol(config.buyAmountSol)}*\n` +
    `📉 Max slippage: *${config.maxSlippageBps} bps*\n` +
    `💧 Min liquidity: *$${config.minLiquidityUsd.toFixed(0)}*\n` +
    `🤖 Min AI score: *${config.minAiScore}*\n` +
    `${stopLossLine}\n` +
    `📐 Exit strategy: *${presetLabel}*` +
    (isKnownPreset(config.trailingStopPreset)
      ? '\n_No fixed take-profit — trailing stop only, distance adapts to liquidity/holder concentration._'
      : '');

  const keyboard = new InlineKeyboard()
    .text('✏️ Buy amount', `a:settings:edit:buyAmountSol:${config.id}`)
    .text('✏️ Slippage', `a:settings:edit:maxSlippageBps:${config.id}`)
    .row()
    .text('✏️ Stop loss', `a:settings:edit:stopLossPercent:${config.id}`)
    .row()
    .text('✏️ Min liquidity', `a:settings:edit:minLiquidityUsd:${config.id}`)
    .text('✏️ Min AI score', `a:settings:edit:minAiScore:${config.id}`)
    .row();

  for (const preset of TRAILING_STOP_PRESETS) {
    keyboard
      .text(TRAILING_STOP_PRESET_LABELS[preset], `a:settings:preset:${preset}:${config.id}`)
      .row();
  }
  keyboard.text('↩️ Custom (manual TP/SL/trailing)', `a:settings:preset:custom:${config.id}`);

  return { text, keyboard: withNav(keyboard, 'home') };
}

function isKnownPreset(
  value: string | null,
): value is Exclude<import('@nova/shared').TrailingStopPreset, 'custom'> {
  return value !== null && (TRAILING_STOP_PRESETS as readonly string[]).includes(value);
}

/** Direct-action (not a pending text prompt) — a button-driven select, not free text. */
export async function applyTrailingStopPreset(
  deps: ScreenDeps,
  user: ScreenUser,
  snipeConfigId: string,
  rawPreset: string,
): Promise<ScreenResult> {
  const config = await deps.prisma.snipeConfig.findUnique({ where: { id: snipeConfigId } });
  if (!config || config.userId !== user.id) return renderSettings(deps, user);

  const preset = rawPreset === 'custom' || isKnownPreset(rawPreset) ? rawPreset : null;
  await deps.prisma.snipeConfig.update({
    where: { id: snipeConfigId },
    data: { trailingStopPreset: preset === 'custom' ? null : preset },
  });

  return renderSettings(deps, user);
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
