import type { Logger } from '@nova/shared';
import { SOL_MINT, type QuoteParams, type QuoteResponse } from '../solana/jupiter.js';

/**
 * DEX-to-DEX arbitrage scanner (paper only).
 *
 * For each configured token it quotes SOL -> token on every configured DEX
 * (single-DEX, direct routes only), then quotes token -> SOL with each buy
 * amount on every OTHER DEX. Each sequential quote pair is reduced by the
 * configured execution-cost estimate and slippage buffer. Quotes are not
 * atomic or a guarantee of an executable return. Nothing is ever executed: an
 * opportunity is only recorded, logged and exposed at /metrics/arbitrage.
 */

export interface ArbitrageConfig {
  mints: string[];
  /** Jupiter DEX labels, e.g. "Raydium", "Whirlpool", "Meteora DLMM". */
  dexes: string[];
  amountLamports: bigint;
  /** Estimated total execution cost: base fee + priority fee + Jito tip. */
  costLamports: bigint;
  /** Safety margin against price movement between quote and landing. */
  slippageBufferBps: number;
  /** Only net results at or above this count as an opportunity. */
  minNetLamports: bigint;
  /** Pause between quote requests, to stay inside Jupiter's rate limit. */
  quoteGapMs: number;
}

export interface RoundTripResult {
  mint: string;
  buyDex: string;
  sellDex: string;
  inLamports: bigint;
  outLamports: bigint;
  grossLamports: bigint;
  netLamports: bigint;
  at: number;
}

export interface RoundTripReport {
  mint: string;
  buyDex: string;
  sellDex: string;
  /** Timestamp of the earlier (buy) quote request, to avoid overstating freshness. */
  at: number;
  inSol: number;
  outSol: number;
  grossSol: number;
  netSol: number;
}

export interface ArbitrageReport {
  enabled: true;
  mode: 'paper';
  scans: number;
  quotesOk: number;
  quotesFailed: number;
  opportunities: number;
  /** Sum of net results of every recorded opportunity — theoretical, never executed. */
  paperNetSol: number;
  bestNetSol: number | undefined;
  lastScanAt: number | undefined;
  lastQuoteAt: number | undefined;
  sessionStartedAt: number;
  running: boolean;
  scanInProgress: boolean;
  configuration: {
    amountSol: number;
    estimatedCostSol: number;
    slippageBufferBps: number;
    minEstimatedNetSol: number;
    dexes: string[];
    mints: string[];
  };
  recent: RoundTripReport[];
  /** Best round trip of the last scan per token, opportunity or not. */
  lastByMint: Record<string, RoundTripReport | null>;
}

const LAMPORTS = 1_000_000_000;
const toSol = (l: bigint) => Number(l) / LAMPORTS;
const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
const serializeRoundTrip = (r: RoundTripResult): RoundTripReport => ({
  mint: r.mint,
  buyDex: r.buyDex,
  sellDex: r.sellDex,
  at: r.at,
  inSol: toSol(r.inLamports),
  outSol: toSol(r.outLamports),
  grossSol: toSol(r.grossLamports),
  netSol: toSol(r.netLamports),
});

/** Net result of a round trip after execution cost and slippage buffer. Pure. */
export function evaluateRoundTrip(
  inLamports: bigint,
  outLamports: bigint,
  costLamports: bigint,
  slippageBufferBps: number,
): { grossLamports: bigint; netLamports: bigint } {
  const grossLamports = outLamports - inLamports;
  const buffer = (inLamports * BigInt(slippageBufferBps)) / 10_000n;
  return { grossLamports, netLamports: grossLamports - costLamports - buffer };
}

type QuoteFn = (params: QuoteParams) => Promise<QuoteResponse>;

export class ArbitrageScanner {
  private timer?: NodeJS.Timeout;
  // Each signal identifies one generation. stop() invalidates even pending quote responses.
  private scanCancellation = new AbortController();
  private running = false;
  private scans = 0;
  private quotesOk = 0;
  private quotesFailed = 0;
  private opportunities = 0;
  private paperNetLamports = 0n;
  private bestNetLamports: bigint | undefined;
  private lastScanAt: number | undefined;
  private lastQuoteAt: number | undefined;
  private readonly sessionStartedAt = Date.now();
  private readonly recent: RoundTripResult[] = [];
  private readonly lastByMint = new Map<string, RoundTripResult | null>();

  constructor(
    private readonly deps: { quote: QuoteFn; logger: Logger },
    private readonly config: ArbitrageConfig,
  ) {}

  start(intervalMs: number): void {
    if (this.timer) return;
    const tick = () => {
      if (this.running) return;
      const generation = this.scanCancellation.signal;
      this.running = true;
      this.scanOnce()
        .catch((err) => this.deps.logger.warn({ err }, 'arbitrage scan failed'))
        .finally(() => {
          // An old scan must not clear the flag of a newly restarted generation.
          if (generation === this.scanCancellation.signal) this.running = false;
        });
    };
    this.timer = setInterval(tick, intervalMs);
    this.timer.unref?.();
    tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.scanCancellation.abort();
    this.scanCancellation = new AbortController();
    this.running = false;
  }

  private async quoteOut(params: QuoteParams, signal: AbortSignal): Promise<bigint | undefined> {
    if (signal.aborted) return undefined;
    try {
      const q = await this.deps.quote(params);
      if (signal.aborted) return undefined;
      if (typeof q.outAmount !== 'string' || !/^\d+$/.test(q.outAmount)) {
        throw new Error('Invalid quote amount');
      }
      const out = BigInt(q.outAmount);
      if (out <= 0n || !Number.isFinite(toSol(out))) throw new Error('Invalid quote amount');
      this.quotesOk++;
      this.lastQuoteAt = Date.now();
      return out;
    } catch {
      if (!signal.aborted) this.quotesFailed++;
      return undefined;
    } finally {
      if (this.config.quoteGapMs > 0) await sleep(this.config.quoteGapMs, signal);
    }
  }

  /** One pass over every configured token. Returns the best round trip per token. */
  async scanOnce(): Promise<RoundTripResult[]> {
    const signal = this.scanCancellation.signal;
    const results: RoundTripResult[] = [];
    for (const mint of this.config.mints) {
      if (signal.aborted) return [];
      const best = await this.scanMint(mint, signal);
      if (signal.aborted) return [];
      this.lastByMint.set(mint, best ?? null);
      if (best) results.push(best);
    }
    if (signal.aborted) return [];
    this.scans++;
    this.lastScanAt = Date.now();
    return results;
  }

  private async scanMint(mint: string, signal: AbortSignal): Promise<RoundTripResult | undefined> {
    const { amountLamports } = this.config;
    const dexes = [...new Set(this.config.dexes)];
    let best: RoundTripResult | undefined;
    for (const buyDex of dexes) {
      if (signal.aborted) return undefined;
      const quotedAt = Date.now();
      const tokens = await this.quoteOut(
        {
          inputMint: SOL_MINT,
          outputMint: mint,
          amountLamports,
          slippageBps: 50,
          dexes: [buyDex],
        },
        signal,
      );
      if (tokens === undefined) continue;
      for (const sellDex of dexes) {
        if (signal.aborted) return undefined;
        if (sellDex === buyDex) continue;
        const out = await this.quoteOut(
          {
            inputMint: mint,
            outputMint: SOL_MINT,
            amountLamports: tokens,
            slippageBps: 50,
            dexes: [sellDex],
          },
          signal,
        );
        if (out === undefined) continue;
        const { grossLamports, netLamports } = evaluateRoundTrip(
          amountLamports,
          out,
          this.config.costLamports,
          this.config.slippageBufferBps,
        );
        if (!best || netLamports > best.netLamports) {
          best = {
            mint,
            buyDex,
            sellDex,
            inLamports: amountLamports,
            outLamports: out,
            grossLamports,
            netLamports,
            at: quotedAt,
          };
        }
      }
    }

    if (signal.aborted) return undefined;
    if (best && best.netLamports >= this.config.minNetLamports) this.record(best);
    return best;
  }

  private record(r: RoundTripResult): void {
    this.opportunities++;
    this.paperNetLamports += r.netLamports;
    if (this.bestNetLamports === undefined || r.netLamports > this.bestNetLamports)
      this.bestNetLamports = r.netLamports;
    this.recent.unshift(r);
    if (this.recent.length > 50) this.recent.pop();
    this.deps.logger.info(
      {
        mint: r.mint,
        buyDex: r.buyDex,
        sellDex: r.sellDex,
        inSol: toSol(r.inLamports),
        grossSol: toSol(r.grossLamports),
        netSol: toSol(r.netLamports),
      },
      'ARBITRAGE OPPORTUNITY (paper, not executed)',
    );
  }

  report(): ArbitrageReport {
    const lastByMint: ArbitrageReport['lastByMint'] = {};
    for (const [mint, r] of this.lastByMint) {
      lastByMint[mint] = r ? serializeRoundTrip(r) : null;
    }
    return {
      enabled: true,
      mode: 'paper',
      scans: this.scans,
      quotesOk: this.quotesOk,
      quotesFailed: this.quotesFailed,
      opportunities: this.opportunities,
      paperNetSol: toSol(this.paperNetLamports),
      bestNetSol: this.bestNetLamports === undefined ? undefined : toSol(this.bestNetLamports),
      lastScanAt: this.lastScanAt,
      lastQuoteAt: this.lastQuoteAt,
      sessionStartedAt: this.sessionStartedAt,
      running: this.timer !== undefined,
      scanInProgress: this.running,
      configuration: {
        amountSol: toSol(this.config.amountLamports),
        estimatedCostSol: toSol(this.config.costLamports),
        slippageBufferBps: this.config.slippageBufferBps,
        minEstimatedNetSol: toSol(this.config.minNetLamports),
        dexes: [...new Set(this.config.dexes)],
        mints: [...new Set(this.config.mints)],
      },
      recent: this.recent.map(serializeRoundTrip),
      lastByMint,
    };
  }
}

let active: ArbitrageScanner | undefined;
export function setActiveArbitrageScanner(s: ArbitrageScanner | undefined): void {
  active = s;
}
export function getActiveArbitrageScanner(): ArbitrageScanner | undefined {
  return active;
}
