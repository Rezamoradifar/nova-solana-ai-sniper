import type { Logger } from '@nova/shared';
import { SOL_MINT, type QuoteParams, type QuoteResponse } from '../solana/jupiter.js';

/**
 * DEX-to-DEX arbitrage scanner (paper only).
 *
 * For each configured token it quotes SOL -> token on every configured DEX
 * (single-DEX, direct routes only), takes the DEX that gives the most tokens,
 * then quotes token -> SOL with that amount on every OTHER DEX. The best round
 * trip minus the real cost of executing it (base fee, priority fee, Jito tip,
 * and a slippage buffer) is the net result. Nothing is ever executed: an
 * opportunity is only recorded, logged and exposed at /metrics/arbitrage.
 */

export interface ArbitrageConfig {
  mints: string[];
  /** Jupiter DEX labels, e.g. "Raydium", "Whirlpool", "Meteora DLMM". */
  dexes: string[];
  amountLamports: bigint;
  /** Execution cost of one atomic round trip: base fee + priority fee + Jito tip. */
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
  recent: (Omit<RoundTripResult, 'inLamports' | 'outLamports' | 'grossLamports' | 'netLamports'> & {
    inSol: number;
    grossSol: number;
    netSol: number;
  })[];
  /** Best round trip of the last scan per token, opportunity or not. */
  lastByMint: Record<string, { buyDex: string; sellDex: string; netSol: number } | null>;
}

const LAMPORTS = 1_000_000_000;
const toSol = (l: bigint) => Number(l) / LAMPORTS;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  private running = false;
  private scans = 0;
  private quotesOk = 0;
  private quotesFailed = 0;
  private opportunities = 0;
  private paperNetLamports = 0n;
  private bestNetLamports: bigint | undefined;
  private lastScanAt: number | undefined;
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
      this.running = true;
      this.scanOnce()
        .catch((err) => this.deps.logger.warn({ err }, 'arbitrage scan failed'))
        .finally(() => {
          this.running = false;
        });
    };
    this.timer = setInterval(tick, intervalMs);
    this.timer.unref?.();
    tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async quoteOut(params: QuoteParams): Promise<bigint | undefined> {
    try {
      const q = await this.deps.quote(params);
      this.quotesOk++;
      return BigInt(q.outAmount);
    } catch {
      this.quotesFailed++;
      return undefined;
    } finally {
      if (this.config.quoteGapMs > 0) await sleep(this.config.quoteGapMs);
    }
  }

  /** One pass over every configured token. Returns the best round trip per token. */
  async scanOnce(): Promise<RoundTripResult[]> {
    const results: RoundTripResult[] = [];
    for (const mint of this.config.mints) {
      const best = await this.scanMint(mint);
      this.lastByMint.set(mint, best ?? null);
      if (best) results.push(best);
    }
    this.scans++;
    this.lastScanAt = Date.now();
    return results;
  }

  private async scanMint(mint: string): Promise<RoundTripResult | undefined> {
    const { amountLamports } = this.config;

    let buy: { dex: string; tokens: bigint } | undefined;
    for (const dex of this.config.dexes) {
      const tokens = await this.quoteOut({
        inputMint: SOL_MINT,
        outputMint: mint,
        amountLamports,
        slippageBps: 50,
        dexes: [dex],
      });
      if (tokens !== undefined && tokens > 0n && (!buy || tokens > buy.tokens))
        buy = { dex, tokens };
    }
    if (!buy) return undefined;

    let best: RoundTripResult | undefined;
    for (const dex of this.config.dexes) {
      if (dex === buy.dex) continue;
      const out = await this.quoteOut({
        inputMint: mint,
        outputMint: SOL_MINT,
        amountLamports: buy.tokens,
        slippageBps: 50,
        dexes: [dex],
      });
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
          buyDex: buy.dex,
          sellDex: dex,
          inLamports: amountLamports,
          outLamports: out,
          grossLamports,
          netLamports,
          at: Date.now(),
        };
      }
    }

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
      lastByMint[mint] = r
        ? { buyDex: r.buyDex, sellDex: r.sellDex, netSol: toSol(r.netLamports) }
        : null;
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
      recent: this.recent.map((r) => ({
        mint: r.mint,
        buyDex: r.buyDex,
        sellDex: r.sellDex,
        at: r.at,
        inSol: toSol(r.inLamports),
        grossSol: toSol(r.grossLamports),
        netSol: toSol(r.netLamports),
      })),
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
