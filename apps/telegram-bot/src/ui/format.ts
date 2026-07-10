export function shortKey(pk: string): string {
  return pk.length <= 12 ? pk : `${pk.slice(0, 6)}…${pk.slice(-4)}`;
}

export function sol(n: number | null | undefined): string {
  return `${(n ?? 0).toFixed(4)} SOL`;
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

/** Escapes Telegram Markdown (legacy) special characters in user/chain-derived strings. */
export function escapeMd(s: string): string {
  return s.replace(/[_*[\]()`]/g, '\\$&');
}
