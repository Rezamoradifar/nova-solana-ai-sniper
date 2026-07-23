import { InlineKeyboard } from 'grammy';
import {
  TRAILING_STOP_PRESETS,
  TRAILING_STOP_PRESET_LABELS,
  DEFAULT_MAX_LOSS_PERCENT,
} from '@nova/shared';
import { withNav } from '../keyboards.js';
import { sol } from '../format.js';
import { normalizeDigits, t, type Locale } from '../../i18n/index.js';
import { getLocale } from '../../i18n/locale.js';
import type { PendingAction } from '../pending.js';
import type { ScreenDeps, ScreenResult, ScreenUser } from '../types.js';

type SettingsField = Extract<PendingAction, { type: 'settings_edit' }>['field'];

function fieldMeta(
  lang: Locale,
  field: SettingsField,
): { label: string; prompt: string; parse: (raw: string) => number | undefined } {
  const m = t(lang).settings.fieldMeta[field];
  switch (field) {
    case 'buyAmountSol':
      return {
        label: m.label,
        prompt: m.prompt as string,
        parse: (raw) => {
          const n = Number(normalizeDigits(raw));
          return Number.isFinite(n) && n > 0 ? n : undefined;
        },
      };
    case 'maxSlippageBps':
      return {
        label: m.label,
        prompt: m.prompt as string,
        parse: (raw) => {
          const n = Number(normalizeDigits(raw));
          return Number.isInteger(n) && n >= 1 && n <= 10000 ? n : undefined;
        },
      };
    case 'minLiquidityUsd':
      return {
        label: m.label,
        prompt: m.prompt as string,
        parse: (raw) => {
          const n = Number(normalizeDigits(raw));
          return Number.isFinite(n) && n >= 0 ? n : undefined;
        },
      };
    case 'minAiScore':
      return {
        label: m.label,
        prompt: m.prompt as string,
        parse: (raw) => {
          const n = Number(normalizeDigits(raw));
          return Number.isFinite(n) && n >= 0 && n <= 100 ? n : undefined;
        },
      };
    // Hard Loss Ceiling (2026-07-18): a user may set a tighter stop loss than
    // DEFAULT_MAX_LOSS_PERCENT, but never a looser one — PositionManager
    // enforces this again at buy time regardless (see exitEngine.ts's
    // resolveEffectiveStopLossPercent), so a value entered here that exceeds
    // the ceiling would silently diverge from what actually protects the
    // position; capping it here too keeps what the user sees consistent with
    // what's actually enforced.
    case 'stopLossPercent':
      return {
        label: m.label,
        prompt: (m.prompt as (ceiling: number) => string)(DEFAULT_MAX_LOSS_PERCENT),
        parse: (raw) => {
          const n = Number(normalizeDigits(raw));
          return Number.isFinite(n) && n > 0 ? Math.min(n, DEFAULT_MAX_LOSS_PERCENT) : undefined;
        },
      };
  }
}

export async function renderSettings(deps: ScreenDeps, user: ScreenUser): Promise<ScreenResult> {
  const lang = getLocale(user);
  const d = t(lang).settings;
  const config = await deps.prisma.snipeConfig.findFirst({
    where: { userId: user.id },
    orderBy: { createdAt: 'desc' },
  });

  if (!config) {
    return {
      text: d.noConfig,
      keyboard: withNav(new InlineKeyboard(), 'home', lang),
    };
  }

  const presetLabel = isKnownPreset(config.trailingStopPreset)
    ? TRAILING_STOP_PRESET_LABELS[config.trailingStopPreset]
    : d.customPresetLabel;

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
      ? d.stopLoss(effectiveStopLossPercent)
      : d.stopLossDefault(effectiveStopLossPercent, DEFAULT_MAX_LOSS_PERCENT);

  const text =
    `${d.title}` +
    `${d.editingNote}` +
    `${d.buyAmount(sol(config.buyAmountSol))}\n` +
    `${d.maxSlippage(config.maxSlippageBps)}\n` +
    `${d.minLiquidity(config.minLiquidityUsd.toFixed(0))}\n` +
    `${d.minAiScore(config.minAiScore)}\n` +
    `${stopLossLine}\n` +
    `${d.exitStrategy(presetLabel)}` +
    (isKnownPreset(config.trailingStopPreset) ? d.trailingOnlyNote : '');

  const keyboard = new InlineKeyboard()
    .text(d.buyAmountBtn, `a:settings:edit:buyAmountSol:${config.id}`)
    .text(d.slippageBtn, `a:settings:edit:maxSlippageBps:${config.id}`)
    .row()
    .text(d.stopLossBtn, `a:settings:edit:stopLossPercent:${config.id}`)
    .row()
    .text(d.minLiquidityBtn, `a:settings:edit:minLiquidityUsd:${config.id}`)
    .text(d.minAiScoreBtn, `a:settings:edit:minAiScore:${config.id}`)
    .row();

  for (const preset of TRAILING_STOP_PRESETS) {
    keyboard
      .text(TRAILING_STOP_PRESET_LABELS[preset], `a:settings:preset:${preset}:${config.id}`)
      .row();
  }
  keyboard.text(d.customPresetBtn, `a:settings:preset:custom:${config.id}`);
  keyboard.row().text(d.languageBtn, 's:language');

  return { text, keyboard: withNav(keyboard, 'home', lang) };
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
  return [
    'buyAmountSol',
    'maxSlippageBps',
    'minLiquidityUsd',
    'minAiScore',
    'stopLossPercent',
  ].includes(value);
}

export function promptFor(field: SettingsField, lang: Locale): ScreenResult {
  const d = t(lang).settings;
  const meta = fieldMeta(lang, field);
  return {
    text: d.promptTitle(meta.label) + meta.prompt,
    keyboard: withNav(new InlineKeyboard(), 'settings', lang),
  };
}

export async function applySettingsEdit(
  deps: ScreenDeps,
  user: ScreenUser,
  snipeConfigId: string,
  field: SettingsField,
  rawValue: string,
): Promise<{ ok: true; result: ScreenResult } | { ok: false; message: string }> {
  const lang = getLocale(user);
  const d = t(lang).settings;
  const meta = fieldMeta(lang, field);
  const parsed = meta.parse(rawValue.trim());
  if (parsed === undefined) {
    return { ok: false, message: d.invalidValue(meta.prompt) };
  }

  const config = await deps.prisma.snipeConfig.findUnique({ where: { id: snipeConfigId } });
  if (!config || config.userId !== user.id) {
    return { ok: false, message: d.configGone };
  }

  await deps.prisma.snipeConfig.update({
    where: { id: snipeConfigId },
    data: { [field]: parsed },
  });

  return { ok: true, result: await renderSettings(deps, user) };
}
