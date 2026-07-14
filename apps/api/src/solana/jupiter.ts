import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';

export const SOL_MINT = 'So11111111111111111111111111111111111111112';

export interface JupiterClientConfig {
  apiBase: string;
}

export interface QuoteParams {
  inputMint: string;
  outputMint: string;
  amountLamports: bigint;
  slippageBps: number;
}

export interface QuoteResponse {
  inAmount: string;
  outAmount: string;
  priceImpactPct: string;
  routePlan: unknown[];
  [key: string]: unknown;
}

export type PriorityLevel = 'medium' | 'high' | 'veryHigh';

export interface SwapBuildOptions {
  /** Ceiling on the priority fee Jupiter's own tiered estimator may spend, in lamports. */
  maxPriorityFeeLamports?: number;
  priorityLevel?: PriorityLevel;
  /**
   * Lets Jupiter's own infrastructure compute slippage from real-time market
   * depth/volatility for this specific route, rather than always using a flat
   * client-side number. `slippageBps` on the quote still acts as the outer bound
   * Jupiter won't exceed, so a caller's configured ceiling is always respected.
   */
  dynamicSlippage?: boolean;
  /**
   * Production Bug Fix (2026-07-14): both HTTP calls below were previously
   * unbounded — a hung Jupiter response blocked the caller (and, for the
   * SELL path, the entire PriceMonitor tick, since it awaits one position at
   * a time) indefinitely. Optional and undefined by default so every
   * pre-existing caller (in particular the BUY path in positionManager.ts,
   * which never passes this) keeps its exact current unbounded behavior —
   * only callers that explicitly opt in get a bounded worst case.
   */
  timeoutMs?: number;
}

function withTimeoutSignal(timeoutMs: number | undefined): AbortSignal | undefined {
  return timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs);
}

export class JupiterClient {
  constructor(private readonly config: JupiterClientConfig) {}

  async getQuote(
    params: QuoteParams,
    options?: Pick<SwapBuildOptions, 'timeoutMs'>,
  ): Promise<QuoteResponse> {
    const url = new URL(`${this.config.apiBase}/swap/v1/quote`);
    url.searchParams.set('inputMint', params.inputMint);
    url.searchParams.set('outputMint', params.outputMint);
    url.searchParams.set('amount', params.amountLamports.toString());
    url.searchParams.set('slippageBps', params.slippageBps.toString());

    const res = await fetch(url, { method: 'GET', signal: withTimeoutSignal(options?.timeoutMs) });
    if (!res.ok) {
      throw new Error(`Jupiter quote failed: ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as QuoteResponse;
  }

  /**
   * `lastValidBlockHeight` (Jupiter computes this alongside the transaction's
   * baked-in blockhash) lets broadcastTransaction confirm against the exact
   * height this specific transaction expires at, instead of the ambiguous
   * signature-only confirmation strategy — see broadcastTransaction's doc
   * comment in positionManager.ts.
   */
  async buildSwapTransaction(
    quote: QuoteResponse,
    userPublicKey: string,
    options?: SwapBuildOptions,
  ): Promise<{ transaction: VersionedTransaction; lastValidBlockHeight?: number }> {
    const prioritizationFeeLamports = options?.maxPriorityFeeLamports
      ? {
          priorityLevelWithMaxLamports: {
            priorityLevel: options.priorityLevel ?? 'high',
            maxLamports: options.maxPriorityFeeLamports,
          },
        }
      : 'auto';

    const res = await fetch(`${this.config.apiBase}/swap/v1/swap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: withTimeoutSignal(options?.timeoutMs),
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey,
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        dynamicSlippage: options?.dynamicSlippage ?? false,
        prioritizationFeeLamports,
      }),
    });
    if (!res.ok) {
      throw new Error(`Jupiter swap build failed: ${res.status} ${await res.text()}`);
    }
    const { swapTransaction, lastValidBlockHeight } = (await res.json()) as {
      swapTransaction: string;
      lastValidBlockHeight?: number;
    };
    const buf = Buffer.from(swapTransaction, 'base64');
    return { transaction: VersionedTransaction.deserialize(buf), lastValidBlockHeight };
  }

  /** Quote + build + sign + simulate, ready to send (directly or via Jito bundle). */
  async prepareSwap(
    connection: Connection,
    signer: Keypair,
    params: QuoteParams,
    options?: SwapBuildOptions,
  ): Promise<{
    quote: QuoteResponse;
    transaction: VersionedTransaction;
    lastValidBlockHeight?: number;
  }> {
    const quote = await this.getQuote(params, options);
    const { transaction, lastValidBlockHeight } = await this.buildSwapTransaction(
      quote,
      signer.publicKey.toBase58(),
      options,
    );
    transaction.sign([signer]);

    const sim = await connection.simulateTransaction(transaction, { sigVerify: false });
    if (sim.value.err) {
      throw new Error(`Swap simulation failed: ${JSON.stringify(sim.value.err)}`);
    }

    return { quote, transaction, lastValidBlockHeight };
  }
}
