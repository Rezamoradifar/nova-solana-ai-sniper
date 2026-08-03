/**
 * Bounded fetch for a token logo URL (DexScreener's `info.imageUrl`, already
 * resolved by marketData.ts) — the only I/O networkTradeCard.ts needs done
 * before it can composite a logo circle. Same fetch-timeout convention as
 * marketData.ts; also caps the downloaded size so a misbehaving/oversized
 * remote image can't tie up memory or sharp's decoder. Never throws: any
 * failure (timeout, non-2xx, non-image content-type, oversized body,
 * undecodable bytes) returns undefined, and the card renders without the
 * logo circle — same "omit rather than invent" convention as every other
 * real-data-only path in this codebase.
 */
const MAX_LOGO_BYTES = 3 * 1024 * 1024; // 3MB — generous for a token logo, small enough to bound memory

export async function fetchNetworkTradeLogo(
  logoUrl: string | undefined,
  fetchTimeoutMs = 4_000,
): Promise<Buffer | undefined> {
  if (!logoUrl) return undefined;
  try {
    const res = await fetch(logoUrl, { signal: AbortSignal.timeout(fetchTimeoutMs) });
    if (!res.ok) return undefined;
    const contentType = res.headers.get('content-type') ?? '';
    if (!contentType.startsWith('image/')) return undefined;
    const contentLength = res.headers.get('content-length');
    if (contentLength && Number(contentLength) > MAX_LOGO_BYTES) return undefined;

    const arrayBuffer = await res.arrayBuffer();
    if (arrayBuffer.byteLength > MAX_LOGO_BYTES) return undefined;
    return Buffer.from(arrayBuffer);
  } catch {
    return undefined;
  }
}
