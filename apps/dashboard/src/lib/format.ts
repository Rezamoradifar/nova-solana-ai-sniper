/** Human-readable "Xd Yh" / "Xh Ym" / "Xm" — same formula as
 * @nova/shared's positionReport.ts formatHoldingTime, kept as a tiny local
 * copy since this browser bundle doesn't depend on @nova/shared (server-only
 * deps like @prisma/client/ioredis aren't meant to ship to the browser). */
export function formatHoldingTime(ms: number): string {
  if (ms < 0) return '0m';
  const totalMinutes = Math.floor(ms / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export function pct(n: number | undefined | null, digits = 1): string {
  return n === undefined || n === null ? '—' : `${n.toFixed(digits)}%`;
}

export function usd(n: number | undefined | null, digits = 2): string {
  if (n === undefined || n === null) return '—';
  return `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(digits)}`;
}

export function sol(n: number | undefined | null, digits = 4): string {
  return n === undefined || n === null ? '—' : `${n.toFixed(digits)} SOL`;
}

/** BigInt lamports (serialized as a string over the wire — see
 * apps/dashboard/src/lib/types.ts's Wallet/LedgerEntry doc comments) to SOL. */
export function lamportsToSol(lamports: string | null | undefined): number | undefined {
  return lamports === null || lamports === undefined ? undefined : Number(BigInt(lamports)) / 1e9;
}

/** "Xm ago" / "Xh Ym ago" — built on formatHoldingTime's same duration formula. */
export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return 'never';
  return `${formatHoldingTime(Date.now() - new Date(iso).getTime())} ago`;
}

/** Full Tailwind class name, not a bare keyword — Tailwind's JIT scanner
 * needs complete class-name literals to find, and `text-${tone}` string
 * interpolation is a well-known way to silently ship unstyled text. */
export function pnlToneClass(n: number | undefined | null): string {
  if (n === undefined || n === null) return 'text-slate-100';
  return n >= 0 ? 'text-profit' : 'text-loss';
}

export const RISK_LABEL_TONE: Record<'Low' | 'Medium' | 'High' | 'Critical', string> = {
  Low: 'text-profit',
  Medium: 'text-amber-400',
  High: 'text-orange-400',
  Critical: 'text-loss',
};

export const TREND_ICON: Record<'bullish' | 'bearish' | 'flat', string> = {
  bullish: '📈',
  bearish: '📉',
  flat: '➡️',
};
