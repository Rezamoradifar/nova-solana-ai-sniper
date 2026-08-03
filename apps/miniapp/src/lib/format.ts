/** Same formulas as apps/dashboard/src/lib/format.ts — kept as a local copy
 * rather than a shared import since that package isn't part of this app's
 * dependency graph, only the tone-class names differ (this app's Tailwind
 * config defines `success`/`danger`, not `profit`/`loss`).
 *
 * Every formatter here treats null/undefined/NaN identically (via
 * isFiniteNumber) so a bad or missing value can never render as the literal
 * text "NaN"/"undefined"/"null" — callers always get a real fallback string
 * instead. */

export function isFiniteNumber(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

export function usd(n: number | undefined | null, digits = 2): string {
  if (!isFiniteNumber(n)) return 'No data';
  return `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(digits)}`;
}

export function sol(n: number | undefined | null, digits = 4): string {
  if (!isFiniteNumber(n)) return 'No data';
  return `${n.toFixed(digits)} SOL`;
}

/** Signed — for a gain/loss percentage (PnL, price change). */
export function pct(n: number | undefined | null, digits = 1): string {
  if (!isFiniteNumber(n)) return 'No data';
  return `${n >= 0 ? '+' : ''}${n.toFixed(digits)}%`;
}

/** Unsigned — for a plain proportion (holder concentration, win rate). */
export function percent(n: number | undefined | null, digits = 0): string {
  if (!isFiniteNumber(n)) return 'No data';
  return `${n.toFixed(digits)}%`;
}

/** A bare integer with no unit (open positions, AI score) — caller picks the
 * fallback since "0" (a real, meaningful count) and "No data" (an unscored/
 * unmeasured value) mean different things depending on the field. */
export function numberOrFallback(n: number | undefined | null, fallback: string): string {
  return isFiniteNumber(n) ? String(n) : fallback;
}

/** BigInt lamports (serialized as a string over the wire — see lib/types.ts's
 * Wallet doc comment) to SOL. Malformed input (should never happen from the
 * API, but this is user-visible money — fail closed to "unknown" rather than
 * throwing and blanking the screen) returns undefined, same as missing. */
export function lamportsToSol(lamports: string | null | undefined): number | undefined {
  if (lamports === null || lamports === undefined) return undefined;
  try {
    return Number(BigInt(lamports)) / 1e9;
  } catch {
    return undefined;
  }
}

/** "Xd Yh" / "Xh Ym" / "Xm" — same formula as apps/dashboard/src/lib/format.ts's
 * formatHoldingTime. */
function formatDuration(ms: number): string {
  if (ms < 0) return '0m';
  const totalMinutes = Math.floor(ms / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/** "Xm ago" / "Xh Ym ago" — never for a future timestamp. */
export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'never';
  return `${formatDuration(Date.now() - date.getTime())} ago`;
}

/** Full Tailwind class name, not a bare keyword — Tailwind's JIT scanner
 * needs complete class-name literals to find, and `text-${tone}` string
 * interpolation is a well-known way to silently ship unstyled text. */
export function pnlToneClass(n: number | undefined | null): string {
  if (!isFiniteNumber(n)) return 'text-text-primary';
  return n >= 0 ? 'text-success' : 'text-danger';
}
