import { PUBLIC_API_BASE, SOL_MINT } from './publicMarket.js';

export const ARB_TOKENS = [
  {
    symbol: 'USDC',
    name: 'USD Coin',
    mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    decimals: 6,
  },
  {
    symbol: 'USDT',
    name: 'Tether',
    mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    decimals: 6,
  },
  {
    symbol: 'JUP',
    name: 'Jupiter',
    mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
    decimals: 6,
  },
  {
    symbol: 'RAY',
    name: 'Raydium',
    mint: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R',
    decimals: 6,
  },
] as const;
export const ARB_DEXES = ['Raydium CLMM', 'Whirlpool', 'Meteora DLMM'] as const;
export const QUOTE_FRESH_MS = 45_000;
const QUOTE_GAP_MS = 2_200;
let nextQuoteAt = 0;
// Solana token raw amounts are unsigned 64-bit integers.
const MAX_RAW_AMOUNT = (1n << 64n) - 1n;

function validRawAmount(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d{1,20}$/.test(value) &&
    BigInt(value) > 0n &&
    BigInt(value) <= MAX_RAW_AMOUNT
  );
}

export interface LiveQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  contextSlot: number;
  priceImpactPct: string;
  routePlan: {
    swapInfo: { label: string; inputMint: string; outputMint: string; ammKey: string };
  }[];
}

export interface LiveRoute {
  id: string;
  token: string;
  mint: string;
  buyDex: string;
  sellDex: string;
  inputSol: number;
  outputSol: number;
  grossSol: number;
  estimatedNetSol: number;
  estimatedNetPercent: number;
  costSol: number;
  bufferSol: number;
  buyQuoteAt: number;
  observedAt: number;
  buyQuote: LiveQuote;
  sellQuote: LiveQuote;
}

export interface ScanProgress {
  phase: string;
  completed: number;
  total: number;
  failed: number;
}
export interface ScanInput {
  token: (typeof ARB_TOKENS)[number];
  amountSol: number;
  costSol: number;
  bufferBps: number;
}

function abortError(): DOMException {
  return new DOMException('Scan stopped', 'AbortError');
}

export function waitForQuote(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const stop = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
      reject(abortError());
    };
    const timer = setTimeout(
      () => {
        signal.removeEventListener('abort', stop);
        resolve();
      },
      Math.max(0, ms),
    );
    signal.addEventListener('abort', stop, { once: true });
  });
}

export function validateQuote(
  raw: unknown,
  inputMint: string,
  outputMint: string,
  amount: bigint,
  dex: string,
): LiveQuote {
  const q = raw as Partial<LiveQuote> | null;
  if (
    !q ||
    amount <= 0n ||
    amount > MAX_RAW_AMOUNT ||
    q.inputMint !== inputMint ||
    q.outputMint !== outputMint ||
    q.inAmount !== amount.toString() ||
    !validRawAmount(q.outAmount) ||
    !validRawAmount(q.otherAmountThreshold) ||
    BigInt(q.otherAmountThreshold) > BigInt(q.outAmount) ||
    !Number.isSafeInteger(q.contextSlot) ||
    q.contextSlot! < 0 ||
    typeof q.priceImpactPct !== 'string' ||
    q.priceImpactPct.trim() === '' ||
    !Number.isFinite(Number(q.priceImpactPct)) ||
    !Array.isArray(q.routePlan) ||
    q.routePlan.length !== 1 ||
    typeof q.routePlan[0]?.swapInfo?.ammKey !== 'string' ||
    q.routePlan[0].swapInfo.ammKey.length === 0 ||
    q.routePlan[0]?.swapInfo?.label !== dex ||
    q.routePlan[0]?.swapInfo?.inputMint !== inputMint ||
    q.routePlan[0]?.swapInfo?.outputMint !== outputMint
  ) {
    throw new Error('The source did not return a valid direct quote.');
  }
  return q as LiveQuote;
}

async function getQuote(
  inputMint: string,
  outputMint: string,
  amount: bigint,
  dex: string,
  signal: AbortSignal,
): Promise<LiveQuote> {
  await waitForQuote(Math.max(0, nextQuoteAt - Date.now()), signal);
  nextQuoteAt = Date.now() + QUOTE_GAP_MS;
  const query = new URLSearchParams({
    inputMint,
    outputMint,
    amount: amount.toString(),
    slippageBps: '50',
    dex,
  });
  const response = await fetch(`${PUBLIC_API_BASE}/public/arbitrage/quote?${query}`, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
  });
  if (!response.ok) {
    if (response.status === 429) nextQuoteAt = Date.now() + 8_000;
    throw new Error(
      response.status === 429
        ? 'Quote source rate limit. The next request will wait.'
        : 'No direct route is available on this venue.',
    );
  }
  return validateQuote(await response.json(), inputMint, outputMint, amount, dex);
}

export function evaluateQuoteCycle(
  inputLamports: bigint,
  outputLamports: bigint,
  costLamports: bigint,
  bufferBps: number,
) {
  if (
    inputLamports <= 0n ||
    outputLamports < 0n ||
    costLamports < 0n ||
    !Number.isInteger(bufferBps) ||
    bufferBps < 0 ||
    bufferBps > 500
  )
    throw new Error('Invalid quote parameters.');
  const bufferLamports = (inputLamports * BigInt(bufferBps) + 9_999n) / 10_000n;
  const netLamports = outputLamports - inputLamports - costLamports - bufferLamports;
  return { netLamports, bufferLamports, grossLamports: outputLamports - inputLamports };
}

/** Read-only quotes. This module never requests, signs or submits a transaction. */
export async function scanLiveRoutes(
  input: ScanInput,
  signal: AbortSignal,
  onProgress: (p: ScanProgress) => void,
  onRoute: (route: LiveRoute) => void,
): Promise<LiveRoute[]> {
  if (
    !ARB_TOKENS.some((t) => t.mint === input.token.mint) ||
    !Number.isFinite(input.amountSol) ||
    input.amountSol < 0.01 ||
    input.amountSol > 10 ||
    !Number.isFinite(input.costSol) ||
    input.costSol < 0 ||
    input.costSol > 0.1 ||
    !Number.isInteger(input.bufferBps) ||
    input.bufferBps < 0 ||
    input.bufferBps > 500
  )
    throw new Error('Choose valid scan parameters.');
  const amount = BigInt(Math.round(input.amountSol * 1e9));
  const cost = BigInt(Math.ceil(input.costSol * 1e9));
  const routes: LiveRoute[] = [];
  let completed = 0;
  let failed = 0;
  const total = ARB_DEXES.length * ARB_DEXES.length;
  for (const buyDex of ARB_DEXES) {
    if (signal.aborted) throw abortError();
    onProgress({
      phase: `Quoting SOL → ${input.token.symbol} on ${buyDex}`,
      completed,
      total,
      failed,
    });
    let buy: LiveQuote;
    let buyQuoteAt: number;
    try {
      buyQuoteAt = Date.now();
      buy = await getQuote(SOL_MINT, input.token.mint, amount, buyDex, signal);
      completed++;
    } catch {
      if (signal.aborted) throw abortError();
      failed++;
      completed += ARB_DEXES.length;
      continue;
    }
    for (const sellDex of ARB_DEXES) {
      if (sellDex === buyDex) continue;
      onProgress({ phase: `Checking ${buyDex} / ${sellDex}`, completed, total, failed });
      try {
        if (Date.now() - buyQuoteAt > QUOTE_FRESH_MS) throw new Error('The buy quote expired.');
        // Quote the exit using the minimum acceptable first-leg output, not its optimistic output.
        const sell = await getQuote(
          input.token.mint,
          SOL_MINT,
          BigInt(buy.otherAmountThreshold),
          sellDex,
          signal,
        );
        const output = BigInt(sell.otherAmountThreshold);
        const evaluated = evaluateQuoteCycle(amount, output, cost, input.bufferBps);
        const route: LiveRoute = {
          id: `${input.token.symbol}-${buyDex}-${sellDex}`,
          token: input.token.symbol,
          mint: input.token.mint,
          buyDex,
          sellDex,
          inputSol: Number(amount) / 1e9,
          outputSol: Number(output) / 1e9,
          grossSol: Number(evaluated.grossLamports) / 1e9,
          estimatedNetSol: Number(evaluated.netLamports) / 1e9,
          estimatedNetPercent: (Number(evaluated.netLamports) / Number(amount)) * 100,
          costSol: Number(cost) / 1e9,
          bufferSol: Number(evaluated.bufferLamports) / 1e9,
          buyQuoteAt,
          observedAt: Date.now(),
          buyQuote: buy,
          sellQuote: sell,
        };
        if (!isRouteFresh(route)) throw new Error('The buy quote expired.');
        routes.push(route);
        onRoute(route);
      } catch {
        if (signal.aborted) throw abortError();
        failed++;
      }
      completed++;
    }
  }
  onProgress({
    phase: routes.length ? 'Scan complete' : 'No direct round-trip routes returned',
    completed: total,
    total,
    failed,
  });
  return routes.sort((a, b) => b.estimatedNetSol - a.estimatedNetSol);
}

/** Age is measured from the earlier request, including its response latency. */
export function isRouteFresh(
  route: Pick<LiveRoute, 'buyQuoteAt' | 'observedAt'>,
  now = Date.now(),
): boolean {
  return (
    Number.isFinite(route.buyQuoteAt) &&
    Number.isFinite(route.observedAt) &&
    route.buyQuoteAt >= 0 &&
    route.observedAt >= route.buyQuoteAt &&
    now >= route.observedAt &&
    now - route.buyQuoteAt <= QUOTE_FRESH_MS
  );
}

export function routesCsv(routes: LiveRoute[]): string {
  const header = [
    'observed_at_utc',
    'token',
    'buy_venue',
    'sell_venue',
    'input_sol',
    'minimum_output_sol',
    'network_budget_sol',
    'extra_buffer_sol',
    'estimated_net_sol',
    'estimated_net_percent',
    'status',
  ];
  return [
    header.join(','),
    ...routes.map((r) =>
      [
        new Date(r.observedAt).toISOString(),
        r.token,
        r.buyDex,
        r.sellDex,
        r.inputSol,
        r.outputSol,
        r.costSol,
        r.bufferSol,
        r.estimatedNetSol,
        r.estimatedNetPercent,
        'quote_observation_not_a_trade',
      ]
        .map((v) => `"${String(v).replaceAll('"', '""')}"`)
        .join(','),
    ),
  ].join('\r\n');
}
