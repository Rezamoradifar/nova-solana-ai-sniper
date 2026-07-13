export function shortKey(pk: string): string {
  return pk.length <= 12 ? pk : `${pk.slice(0, 6)}…${pk.slice(-4)}`;
}

export function sol(n: number | null | undefined): string {
  return `${(n ?? 0).toFixed(4)} SOL`;
}

const LAMPORTS_PER_SOL = 1_000_000_000;

export function lamportsToSol(lamports: bigint | null | undefined): number {
  return lamports === null || lamports === undefined ? 0 : Number(lamports) / LAMPORTS_PER_SOL;
}

/** "Xm ago" / "Xh Ym ago" — built on fmtHoldingTimeShort's same duration formula. */
export function fmtAgo(d: Date | null | undefined): string {
  if (!d) return 'never';
  return `${fmtHoldingTimeShort(Date.now() - d.getTime())} ago`;
}

export function usd(n: number | null | undefined): string {
  const v = n ?? 0;
  return `${v < 0 ? '-' : ''}$${Math.abs(v).toFixed(2)}`;
}

export function pnlEmoji(n: number | null | undefined): string {
  return (n ?? 0) >= 0 ? '🟢' : '🔴';
}

export function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 16).replace('T', ' ');
}

/** Human-readable "Xd Yh" / "Xh Ym" / "Xm" — same formula as
 * @nova/shared's positionReport.ts formatHoldingTime. */
export function fmtHoldingTimeShort(ms: number): string {
  if (ms < 0) return '0m';
  const totalMinutes = Math.floor(ms / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/** Escapes Telegram Markdown (legacy) special characters in user/chain-derived strings. */
export function escapeMd(s: string): string {
  return s.replace(/[_*[\]()`]/g, '\\$&');
}
