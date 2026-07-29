/**
 * Rolling realized-volatility signal for the tp1_trailing_v1 exit strategy's
 * volatility-adaptive trailing distance (see tp1TrailingStrategy.ts). No
 * volatility/ATR/price-variance signal exists anywhere else in this codebase
 * — this is a from-scratch, in-memory-only, process-lifetime signal, which
 * is an acceptable trade-off here: it's a soft adaptive input to the
 * trailing-stop distance, not a safety-critical value (the hard 20% stop-loss
 * ceiling and the Emergency Exit Engine are both DB-persisted/authoritative
 * and completely unaffected by this).
 *
 * Stddev is computed over percent returns between consecutive samples, not
 * raw price — this reads correctly regardless of a token's absolute price
 * scale (a $0.0000001 token and a $50 token are equally well-represented).
 */

const DEFAULT_MAX_SAMPLES = 20;
const DEFAULT_MAX_SAMPLE_AGE_MS = 20 * 60_000;
const MIN_SAMPLES_FOR_STDDEV = 5;

interface Sample {
  priceUsd: number;
  atMs: number;
}

export class PriceVolatilityTracker {
  private readonly samplesByPosition = new Map<string, Sample[]>();

  constructor(
    private readonly maxSamples: number = DEFAULT_MAX_SAMPLES,
    private readonly maxSampleAgeMs: number = DEFAULT_MAX_SAMPLE_AGE_MS,
  ) {}

  /** Records one price observation for a position, evicting samples older
   * than maxSampleAgeMs or beyond maxSamples (oldest first). */
  recordSample(positionId: string, priceUsd: number, atMs: number): void {
    if (!Number.isFinite(priceUsd) || priceUsd <= 0) return;
    const samples = this.samplesByPosition.get(positionId) ?? [];
    samples.push({ priceUsd, atMs });

    const cutoffMs = atMs - this.maxSampleAgeMs;
    let firstValidIndex = 0;
    while (firstValidIndex < samples.length && samples[firstValidIndex]!.atMs < cutoffMs) {
      firstValidIndex++;
    }
    const trimmedByAge = firstValidIndex > 0 ? samples.slice(firstValidIndex) : samples;
    const trimmed =
      trimmedByAge.length > this.maxSamples
        ? trimmedByAge.slice(trimmedByAge.length - this.maxSamples)
        : trimmedByAge;

    this.samplesByPosition.set(positionId, trimmed);
  }

  /** Rolling stddev of percent returns between consecutive samples, as a
   * percent (e.g. 5 means 5%). Undefined when fewer than
   * MIN_SAMPLES_FOR_STDDEV samples are on file yet — the caller (
   * tp1TrailingStrategy.ts) treats this as "no adjustment" rather than a
   * fabricated low-volatility reading. */
  getRollingStdDevPercent(positionId: string): number | undefined {
    const samples = this.samplesByPosition.get(positionId);
    if (!samples || samples.length < MIN_SAMPLES_FOR_STDDEV) return undefined;

    const returns: number[] = [];
    for (let i = 1; i < samples.length; i++) {
      const prev = samples[i - 1]!.priceUsd;
      const curr = samples[i]!.priceUsd;
      returns.push(((curr - prev) / prev) * 100);
    }
    if (returns.length < MIN_SAMPLES_FOR_STDDEV - 1) return undefined;

    const mean = returns.reduce((sum, r) => sum + r, 0) / returns.length;
    const variance = returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / returns.length;
    return Math.sqrt(variance);
  }

  /** Releases a position's samples — called once a position closes, so this
   * in-memory map never grows unbounded across a long-running process. */
  forget(positionId: string): void {
    this.samplesByPosition.delete(positionId);
  }
}
