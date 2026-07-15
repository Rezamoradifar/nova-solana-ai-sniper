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
  mountMiniApp,
  miniAppReady,
  mountThemeParams,
  isThemeParamsDark,
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

/**
 * Flips <html data-theme> to match Telegram's real theme (dark/light) and
 * keeps it in sync as the user changes it inside Telegram — this is what
 * index.css's [data-theme="light"] / [data-theme="dark"] blocks respond to.
 * Design brief: dark-first, "fall back to your dark theme when colorScheme
 * is unavailable" — so outside Telegram (isTMA() false, e.g. plain-browser
 * local dev) this never runs and the html tag's default data-theme="dark"
 * (set in index.html) simply stands.
 */
function syncTelegramTheme(): void {
  const applyTheme = () => {
    document.documentElement.dataset.theme = isThemeParamsDark() ? 'dark' : 'light';
  };
  applyTheme();
  isThemeParamsDark.sub(applyTheme);
}

export interface TelegramInitResult {
  /** True only when actually running inside a Telegram client. Every other
   * export in this module is safe to call either way (SDK calls are simply
   * no-ops/return undefined outside Telegram), but callers that need to
   * branch UI (e.g. "open this in Telegram" messaging) can check this. */
  isInsideTelegram: boolean;
}

let initialized = false;

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

  mountMiniApp();
  mountThemeParams();
  bindThemeParamsCssVars();
  syncTelegramTheme();

  mountViewport().catch(() => {
    // Best-effort — an unsupported/older Telegram client just keeps the
    // browser's own viewport; nothing downstream depends on this succeeding.
  });
  expandViewport();

  if (isBackButtonSupported()) {
    mountBackButton();
  }

  miniAppReady();

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
