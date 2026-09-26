/**
 * Thin wrapper around @telegram-apps/sdk's real, verified API surface (checked
 * against the installed package's own .d.ts files, not guessed — v3.11.8's
 * component APIs are signal-based: a signal is called as a function to read
 * its current value, and has a `.sub(listener)` method to subscribe to
 * changes). Nothing here talks to the backend — that's lib/auth.ts, built in
 * the next increment once this scaffold is reviewed.
 */
import {
  init,
  isTMA,
  restoreInitData,
  initDataRaw,
  mountMiniAppSync,
  miniAppReady,
  mountThemeParamsSync,
  bindThemeParamsCssVars,
  mountViewport,
  expandViewport,
  mountBackButton,
  isBackButtonSupported,
  showBackButton,
  hideBackButton,
  onBackButtonClick,
  offBackButtonClick,
  hapticFeedback,
  isHapticFeedbackSupported,
} from '@telegram-apps/sdk';

export interface TelegramInitResult {
  /** True only when actually running inside a Telegram client. Every other
   * export in this module is safe to call either way (SDK calls are simply
   * no-ops/return undefined outside Telegram), but callers that need to
   * branch UI (e.g. "open this in Telegram" messaging) can check this. */
  isInsideTelegram: boolean;
}

let initialized = false;

function safely(step: () => void): void {
  try {
    step();
  } catch (err) {
    console.warn('[telegram] optional Mini App setup step failed', err);
  }
}

/**
 * Call exactly once, before rendering the app. Idempotent — a second call
 * (e.g. React StrictMode double-invoke in dev) is a no-op.
 */
export function initTelegram(): TelegramInitResult {
  if (initialized) return { isInsideTelegram: isTMA() };
  initialized = true;

  if (!isTMA()) {
    return { isInsideTelegram: false };
  }

  init();
  restoreInitData();

  // Everything below is cosmetic (theme, full-height, back button). Each step
  // is isolated so one unsupported feature on some Telegram client can never
  // throw out of here and block sign-in.
  safely(() => mountMiniAppSync());
  safely(() => {
    // The GSP brand is dark-only, so Telegram's light theme is not mirrored.
    mountThemeParamsSync();
    bindThemeParamsCssVars();
  });
  safely(() => {
    mountViewport().catch(() => undefined);
    expandViewport();
  });
  safely(() => {
    if (isBackButtonSupported()) mountBackButton();
  });
  safely(() => miniAppReady());

  return { isInsideTelegram: true };
}

/** The raw, signed initData string — this is what gets sent to the (not yet
 * built) POST /auth/telegram for HMAC verification. Undefined outside
 * Telegram or before initTelegram() has run. */
export function getInitDataRaw(): string | undefined {
  return initDataRaw();
}

export interface BackButtonHandle {
  (): void;
}

/** Shows the native back button for the lifetime of the calling screen,
 * invoking `onBack` on tap, and cleans up automatically — call from a
 * screen's mount effect and invoke the returned function on unmount. */
export function useNativeBackButton(onBack: () => void): BackButtonHandle {
  if (!isBackButtonSupported()) {
    return () => {};
  }
  showBackButton();
  onBackButtonClick(onBack);
  return () => {
    offBackButtonClick(onBack);
    hideBackButton();
  };
}

export const haptics = {
  /** Light tap feedback for a routine tap/selection change. */
  tap(): void {
    if (isHapticFeedbackSupported()) hapticFeedback.selectionChanged();
  },
  /** A meaningful, successful action (trade filled, saved, etc). */
  success(): void {
    if (isHapticFeedbackSupported()) hapticFeedback.notificationOccurred('success');
  },
  /** A failed action / blocked action. */
  error(): void {
    if (isHapticFeedbackSupported()) hapticFeedback.notificationOccurred('error');
  },
  /** A weightier confirmation moment (e.g. about to sell/withdraw). */
  impact(): void {
    if (isHapticFeedbackSupported()) hapticFeedback.impactOccurred('medium');
  },
};
