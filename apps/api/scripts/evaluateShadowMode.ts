/**
 * Shadow-mode evaluation report (Sections 3-4, 2026-07-22): reads
 * ShadowModeDecisionLog rows that have completed their 24h sampling window
 * and computes precision, false-positive rate, rug/scam-miss rate, and
 * hypothetical PnL for the hypothetical BUY predictions — offline analysis
 * only, never executes or affects a real trade.
 *
 * The "success" bar for a BUY prediction (>=20% up at the 24h sample) is a
 * named, documented constant below, not silently assumed — reconsider it
 * against the full outcome distribution this script also prints, rather than
 * only the single pass/fail cut.
 *
 * Usage: npm run evaluate-shadow-mode --workspace apps/api [-- --days 7]
 */
import { PrismaClient } from '@prisma/client';

/** A BUY prediction counts as a true positive if price24hUsd is at least
 * this multiple of priceAtDetectionUsd. Tunable — reconsider against the
 * printed outcome distribution, not just this single cut. */
const SUCCESS_THRESHOLD_MULTIPLE = 1.2;

/** Hypothetical notional per BUY prediction for the PnL estimate — matches
 * candidatePipeline.ts's own SELLABILITY_CHECK_NOTIONAL_SOL convention.
 * Explicitly unmodeled: slippage, fees, execution risk, partial fills. */
const HYPOTHETICAL_NOTIONAL_SOL = 0.1;

function parseDaysArg(argv: string[]): number | undefined {
  const idx = argv.indexOf('--days');
  if (idx === -1) return undefined;
  const value = Number(argv[idx + 1]);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

async function main() {
  const prisma = new PrismaClient();

  const days = parseDaysArg(process.argv.slice(2));
  const since = days !== undefined ? new Date(Date.now() - days * 24 * 60 * 60 * 1000) : undefined;

  const rows = await prisma.shadowModeDecisionLog.findMany({
    where: {
      sampledAt24h: { not: null },
      ...(since ? { detectedAt: { gte: since } } : {}),
    },
  });

  console.log(`Shadow-mode evaluation report${days !== undefined ? ` (last ${days} days)` : ''}`);
  console.log(`Rows with a completed 24h sample: ${rows.length}\n`);

  if (rows.length === 0) {
    console.log('No completed rows yet — nothing to evaluate.');
    await prisma.$disconnect();
    return;
  }

  const buys = rows.filter((r) => r.hypotheticalDecision === 'BUY');
  const watches = rows.filter((r) => r.hypotheticalDecision === 'WATCH');
  const skips = rows.filter((r) => r.hypotheticalDecision === 'SKIP');
  console.log(`Decisions — BUY: ${buys.length}, WATCH: ${watches.length}, SKIP: ${skips.length}\n`);

  const buysWithPrice = buys.filter(
    (r) => r.priceAtDetectionUsd !== null && r.priceAtDetectionUsd > 0 && r.price24hUsd !== null,
  );

  if (buysWithPrice.length === 0) {
    console.log(
      'No BUY rows have both a detection price and a 24h sample — precision/PnL not computable yet.',
    );
  } else {
    const outcomes = buysWithPrice.map((r) => ({
      mint: r.mint,
      multiple: r.price24hUsd! / r.priceAtDetectionUsd!,
      wasRug: r.wasRugOrScamBySample === true,
    }));

    const successes = outcomes.filter((o) => o.multiple >= SUCCESS_THRESHOLD_MULTIPLE);
    const precision = successes.length / outcomes.length;
    const falsePositiveRate = 1 - precision;
    const rugCount = outcomes.filter((o) => o.wasRug).length;
    const rugMissRate = rugCount / outcomes.length;

    const hypotheticalPnlSol = outcomes.reduce(
      (sum, o) => sum + HYPOTHETICAL_NOTIONAL_SOL * (o.multiple - 1),
      0,
    );

    console.log(`BUY predictions with a usable price pair: ${outcomes.length}`);
    console.log(
      `Precision (>= ${((SUCCESS_THRESHOLD_MULTIPLE - 1) * 100).toFixed(0)}% at 24h): ${(precision * 100).toFixed(1)}%`,
    );
    console.log(`False-positive rate: ${(falsePositiveRate * 100).toFixed(1)}%`);
    console.log(
      `Rug/scam-miss rate (BUY predictions that later looked like a rug): ${(rugMissRate * 100).toFixed(1)}%`,
    );
    console.log(
      `Hypothetical PnL (${HYPOTHETICAL_NOTIONAL_SOL} SOL/trade, unmodeled slippage/fees): ${hypotheticalPnlSol >= 0 ? '+' : ''}${hypotheticalPnlSol.toFixed(4)} SOL\n`,
    );

    console.log('Outcome distribution (price at 24h / price at detection):');
    const buckets = [
      { label: '<0.5x (rug/collapse)', test: (m: number) => m < 0.5 },
      { label: '0.5x-1x', test: (m: number) => m >= 0.5 && m < 1 },
      { label: '1x-1.2x', test: (m: number) => m >= 1 && m < SUCCESS_THRESHOLD_MULTIPLE },
      { label: '1.2x-2x', test: (m: number) => m >= SUCCESS_THRESHOLD_MULTIPLE && m < 2 },
      { label: '2x-5x', test: (m: number) => m >= 2 && m < 5 },
      { label: '>=5x', test: (m: number) => m >= 5 },
    ];
    for (const bucket of buckets) {
      const count = outcomes.filter((o) => bucket.test(o.multiple)).length;
      console.log(`  ${bucket.label}: ${count}`);
    }
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
