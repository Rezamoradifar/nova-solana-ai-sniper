import type { QuoteResponse } from '../solana/jupiter.js';

const BPS_DENOMINATOR = 10_000n;

export interface FlashArbitrageRiskConfig {
  /** Maximum principal the strategy may borrow, expressed in the base token's raw units. */
  maxBorrowBaseUnits: bigint;
  /** Minimum guaranteed net edge after the configured execution-cost reserve. */
  minNetBps: number;
  /** Maximum price impact per Jupiter leg. Jupiter reports priceImpactPct as a decimal ratio. */
  maxPriceImpactBps: number;
  /** Old quotes must never be converted into a transaction. */
  maxQuoteAgeMs: number;
  /** LIVE requires this independent, explicit second switch. */
  liveExecutionEnabled: boolean;
}

export interface FlashArbitrageCandidate {
  baseMint: string;
  intermediateMint: string;
  borrowAmount: bigint;
  /** Conservative amount used for leg two: leg one's otherAmountThreshold. */
  intermediateMinOut: bigint;
  /** Conservative final base-token return: leg two's otherAmountThreshold. */
  finalMinOut: bigint;
  /** Total reserved network / priority / Jito / integration costs in base-token raw units. */
  estimatedExecutionCostBaseUnits: bigint;
  buyDex: string;
  sellDex: string;
  buyQuoteAt: number;
  sellQuoteAt: number;
  buyQuote: QuoteResponse;
  sellQuote: QuoteResponse;
}

export interface FlashArbitrageEvaluation {
  accepted: boolean;
  reason:
    | 'ok'
    | 'invalid_candidate'
    | 'borrow_limit'
    | 'stale_quote'
    | 'price_impact'
    | 'below_minimum_edge';
  guaranteedNetBaseUnits: bigint;
  guaranteedNetBps: number;
  worstPriceImpactBps: number;
}

export interface FlashLoanBuild {
  /** Opaque transaction object owned by the concrete Project 0 adapter. */
  transaction: unknown;
  /** Optional diagnostics surfaced by the builder before simulation. */
  txSizeBytes?: number;
  accountLocks?: number;
}

export interface FlashLoanSimulation {
  ok: boolean;
  error?: string;
  logs?: string[];
}

export interface FlashLoanRuntime {
  /**
   * Concrete implementation must compose one atomic transaction:
   * begin flash loan -> borrow -> swap A -> swap B -> repay -> end flash loan.
   */
  buildAtomic(candidate: FlashArbitrageCandidate): Promise<FlashLoanBuild>;
  simulate(build: FlashLoanBuild): Promise<FlashLoanSimulation>;
  submit(build: FlashLoanBuild): Promise<string>;
}

export type FlashExecutionMode = 'SIMULATION' | 'LIVE';

export type FlashArbitrageExecutionResult =
  | {
      status: 'REJECTED';
      evaluation: FlashArbitrageEvaluation;
    }
  | {
      status: 'SIMULATED';
      evaluation: FlashArbitrageEvaluation;
      build: FlashLoanBuild;
      simulation: FlashLoanSimulation;
    }
  | {
      status: 'SIMULATION_FAILED';
      evaluation: FlashArbitrageEvaluation;
      build: FlashLoanBuild;
      simulation: FlashLoanSimulation;
    }
  | {
      status: 'SUBMITTED';
      evaluation: FlashArbitrageEvaluation;
      build: FlashLoanBuild;
      simulation: FlashLoanSimulation;
      signature: string;
    };

function rawAmount(value: unknown): bigint | undefined {
  if (typeof value !== 'string' || !/^\\d+$/.test(value)) return undefined;
  try {
    const amount = BigInt(value);
    return amount >= 0n ? amount : undefined;
  } catch {
    return undefined;
  }
}

function quotePriceImpactBps(quote: QuoteResponse): number | undefined {
  if (typeof quote.priceImpactPct !== 'string' || quote.priceImpactPct.trim() === '') return undefined;
  const ratio = Number(quote.priceImpactPct);
  if (!Number.isFinite(ratio) || ratio < 0) return undefined;
  return ratio * 10_000;
}

export function evaluateFlashArbitrage(
  candidate: FlashArbitrageCandidate,
  config: FlashArbitrageRiskConfig,
  now = Date.now(),
): FlashArbitrageEvaluation {
  const empty = {
    accepted: false,
    reason: 'invalid_candidate' as const,
    guaranteedNetBaseUnits: 0n,
    guaranteedNetBps: 0,
    worstPriceImpactBps: Number.POSITIVE_INFINITY,
  };

  if (
    candidate.baseMint.length === 0 ||
    candidate.intermediateMint.length === 0 ||
    candidate.baseMint === candidate.intermediateMint ||
    candidate.borrowAmount <= 0n ||
    candidate.intermediateMinOut <= 0n ||
    candidate.finalMinOut <= 0n ||
    candidate.estimatedExecutionCostBaseUnits < 0n ||
    !Number.isInteger(config.minNetBps) ||
    config.minNetBps < 0 ||
    !Number.isFinite(config.maxPriceImpactBps) ||
    config.maxPriceImpactBps < 0 ||
    !Number.isInteger(config.maxQuoteAgeMs) ||
    config.maxQuoteAgeMs <= 0 ||
    config.maxBorrowBaseUnits <= 0n ||
    !Number.isFinite(candidate.buyQuoteAt) ||
    !Number.isFinite(candidate.sellQuoteAt) ||
    candidate.buyQuoteAt < 0 ||
    candidate.sellQuoteAt < candidate.buyQuoteAt ||
    now < candidate.sellQuoteAt
  ) {
    return empty;
  }

  if (
    candidate.buyQuote.inputMint !== candidate.baseMint ||
    candidate.buyQuote.outputMint !== candidate.intermediateMint ||
    candidate.sellQuote.inputMint !== candidate.intermediateMint ||
    candidate.sellQuote.outputMint !== candidate.baseMint ||
    rawAmount(candidate.buyQuote.inAmount) !== candidate.borrowAmount ||
    rawAmount(candidate.buyQuote.otherAmountThreshold) !== candidate.intermediateMinOut ||
    rawAmount(candidate.sellQuote.inAmount) !== candidate.intermediateMinOut ||
    rawAmount(candidate.sellQuote.otherAmountThreshold) !== candidate.finalMinOut
  ) {
    return empty;
  }

  if (candidate.borrowAmount > config.maxBorrowBaseUnits) {
    return { ...empty, reason: 'borrow_limit' };
  }

  if (now - candidate.buyQuoteAt > config.maxQuoteAgeMs) {
    return { ...empty, reason: 'stale_quote' };
  }

  const buyImpact = quotePriceImpactBps(candidate.buyQuote);
  const sellImpact = quotePriceImpactBps(candidate.sellQuote);
  if (buyImpact === undefined || sellImpact === undefined) return empty;
  const worstPriceImpactBps = Math.max(buyImpact, sellImpact);
  const guaranteedNetBaseUnits =
    candidate.finalMinOut - candidate.borrowAmount - candidate.estimatedExecutionCostBaseUnits;
  const guaranteedNetBps =
    guaranteedNetBaseUnits <= 0n
      ? Number((guaranteedNetBaseUnits * BPS_DENOMINATOR) / candidate.borrowAmount)
      : Number((guaranteedNetBaseUnits * BPS_DENOMINATOR) / candidate.borrowAmount);

  if (worstPriceImpactBps > config.maxPriceImpactBps) {
    return {
      accepted: false,
      reason: 'price_impact',
      guaranteedNetBaseUnits,
      guaranteedNetBps,
      worstPriceImpactBps,
    };
  }

  if (guaranteedNetBps < config.minNetBps) {
    return {
      accepted: false,
      reason: 'below_minimum_edge',
      guaranteedNetBaseUnits,
      guaranteedNetBps,
      worstPriceImpactBps,
    };
  }

  return {
    accepted: true,
    reason: 'ok',
    guaranteedNetBaseUnits,
    guaranteedNetBps,
    worstPriceImpactBps,
  };
}

/**
 * Simulation is mandatory in every mode. LIVE additionally requires the
 * independent liveExecutionEnabled switch; there is no simulation bypass.
 */
export class FlashArbitrageExecutor {
  constructor(
    private readonly runtime: FlashLoanRuntime,
    private readonly config: FlashArbitrageRiskConfig,
  ) {}

  async execute(
    candidate: FlashArbitrageCandidate,
    mode: FlashExecutionMode = 'SIMULATION',
    now = Date.now(),
  ): Promise<FlashArbitrageExecutionResult> {
    const evaluation = evaluateFlashArbitrage(candidate, this.config, now);
    if (!evaluation.accepted) return { status: 'REJECTED', evaluation };

    if (mode === 'LIVE' && !this.config.liveExecutionEnabled) {
      throw new Error('Flash arbitrage LIVE execution is disabled by the independent safety gate.');
    }

    const build = await this.runtime.buildAtomic(candidate);
    const simulation = await this.runtime.simulate(build);
    if (!simulation.ok) {
      return { status: 'SIMULATION_FAILED', evaluation, build, simulation };
    }

    if (mode === 'SIMULATION') {
      return { status: 'SIMULATED', evaluation, build, simulation };
    }

    const signature = await this.runtime.submit(build);
    return { status: 'SUBMITTED', evaluation, build, simulation, signature };
  }
}
