/**
 * Historical PnL / decimals reconciliation (2026-07-23, USOH incident
 * follow-up). One-off, run once. Corrects three things, all caused by the
 * same root cause (Token.decimals defaulting to 9 instead of each mint's
 * real on-chain value) plus one unrelated pre-2026-07-11 price-glitch bug
 * on two very early positions:
 *
 *   1. Token.decimals — backfilled to the real on-chain value.
 *   2. Position.realizedPnlUsd — recomputed from each position's REAL
 *      confirmed BUY/SELL trade data (amountSol, which is always correct —
 *      sourced directly from the swap's actual on-chain execution, never
 *      decimals-dependent) rather than trusting the stored value.
 *   3. performance_fee_ledger / referral_rewards rows derived from an
 *      affected position's PnL.
 *
 * Never touches: wallet balances, treasury tables, payout execution, or any
 * on-chain data (impossible anyway — this only ever writes to Postgres).
 * Every changed value is logged to pnl_reconciliation_log (append-only,
 * never updated) before the corresponding table is written.
 *
 * Usage:
 *   npm run reconcile-pnl --workspace apps/api                # dry run (default, no writes)
 *   npm run reconcile-pnl --workspace apps/api -- --execute   # apply for real, in one transaction
 */
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

const prisma = new PrismaClient();
const EXECUTE = process.argv.includes('--execute');

/**
 * Verified 2026-07-23 via live Helius RPC getAccountInfo (jsonParsed) against
 * each mint directly — see the conversation this script was built from for
 * the full methodology. A mint's decimals is an immutable on-chain property
 * (fixed at mint creation, SPL Token/Token-2022 both), so this mapping never
 * goes stale for these specific mints. SIMTEST-prefixed mints are paper
 * trades (no real mint exists) and are excluded entirely, everywhere below.
 */
const REAL_DECIMALS: Record<string, number> = {
  '2ACRyurPtXRwXGEL8XaMPLhozAonxCgMPKFUix4opump': 6,
  '2Dyh7EUSbqxZBz1PAa1BeCvrzpBNtenVVVLxbgmWtMrL': 6,
  '2wzVMXhLypmP92mXNCq4fuFcd9TCC972AbMfuiH3pump': 6,
  '3HfLqhtF5hR5dyBXh6BMtRaTm9qzStvEGuMa8Gx6pump': 6,
  '3dejiWxvpL6QH63rBE38fSrVbna8pVrKbmbPPDke7wuH': 6,
  '5MJPRjEVyjQEBXnUmhPfXGp7SqBhbZdGGwj8ZQAA7fWx': 6,
  '5SVG3T9CNQsm2kEwzbRq6hASqh1oGfjqTtLXYUibpump': 6,
  '5vCJnii4Nby3nuTrJrJsHWDGY4jttT9s6Gs3HkTfpump': 6,
  '61V8vBaqAGMpgDQi4JcAwo1dmBGHsyhzodcPqnEVpump': 6,
  '6MQpbiTC2YcogidTmKqMLK82qvE9z5QEm7EP3AEDpump': 6,
  '6iyw9CwHp2onnju1FGji8XxRhq4quwAUCiuSdf2Mbonk': 6,
  '6mgqeeGHE5GrVk9fYdeJSjKTFZV1TVNAQTMYdHjfpump': 6,
  '6q2cfpsyeo9gA8wyybq8egKhNZsvGcfc5L2wC2K4mWtQ': 6,
  '8NGpdSE1tZqUrvpUVqsn5Revncc6yUafk8mnAyK9fNCE': 6,
  '8a5NY9MAdY3NjKsgPUYfqoZcmGKdZkotrjWgZM1dpump': 6,
  BdmmbhuqmMcswTCpP5Dy9H6E87ZqDMULVAWdzu4ZhqTS: 6,
  CBdCxKo9QavR9hfShgpEBG3zekorAeD7W1jfq2o3pump: 6,
  CLyhG2aVrnvbxXAXokBGvKjmNfsamPKtGW4Gu9AHpump: 6,
  CM2edFRVwAsNbCXrr8fRJ7VeuWE3Htcchcpvk6L7HCB9: 6,
  CnXZEuUU2jBshGuY6xxWASgX84QPhFuFS8yYWPgSpump: 6,
  DMwbVy48dWVKGe9z1pcVnwF3HLMLrqWdDLfbvx8RchhK: 6,
  DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263: 5, // BONK — real, well-known value
  ED5nyyWEzpPPiWimP8vYm7sD7TD3LAt3Q3gRTWHzPJBY: 6,
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 6, // USDC
  EWqbBJVFaLof1bRVocPkwjSfZHTGDGfPJ6AU72Tspump: 6,
  Eg2ymQ2aQqjMcibnmTt8erC6Tvk9PVpJZCxvVPJz2agu: 6,
  FCR5PjritfaxoYwwDzrYybCKoN3pJDjQ6gNcsymkpump: 6,
  FsA54yL49WKs7rWoGv9sUcbSGWCWV756jTD349e6H2yW: 6,
  GnM6XZ7DN9KSPW2ZVMNqCggsxjnxHMGb2t4kiWrUpump: 6,
  GvV7sFu6FHJsSVXfpG7xqFnWar3c7YkcC74rqe7Bpump: 6,
  HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3: 6,
  Hcxmy6NH4h9GJWb5msDhtikkF6ZTk2gMwgb8SRUFNjrE: 6,
  J2PiC6EVeSRJLqozVKj3oYwUkpLJZUaWZav9SAGmrbuF: 6,
  J6xVwPee2YSxMF4chUHNpPEkkyesWmDtiF11SZWCpump: 6,
  YPcvyLXwAFVRhyT7AHirVUrVg6HkpTMpSSRMENmpump: 6, // USOH
  sKCmfbM4b7ezRkSniDLFQuayX8K82sEuqrrjFF5pump: 6,
};

const MATERIAL_DIFF_USD = 1e-9; // floating-point noise floor, not a real threshold

interface AuditRow {
  tableName: string;
  recordId: string;
  fieldName: string;
  oldValue: string;
  newValue: string;
  reason: string;
}

interface PositionCorrection {
  positionId: string;
  mint: string;
  symbol: string | null;
  oldRealizedPnlUsd: number | null;
  newRealizedPnlUsd: number;
  realPnlSol: number;
  totalBuySol: number;
  totalSellSol: number;
}

interface TokenCorrection {
  tokenId: string;
  mint: string;
  oldDecimals: number;
  newDecimals: number;
}

/** Same wallet+mint+time-window trade matching used in the audit — a BUY
 * trade's own createdAt can predate position.createdAt (pre-2026-07-14, before
 * the atomic trade+position write), so this takes the most recent BUY at or
 * before position.createdAt rather than a fixed window; SELL trades are
 * everything CONFIRMED between position.createdAt and position.closedAt. */
async function matchTrades(position: {
  id: string;
  walletId: string;
  tokenId: string;
  createdAt: Date;
  closedAt: Date | null;
}) {
  const trades = await prisma.trade.findMany({
    where: { walletId: position.walletId, tokenId: position.tokenId, status: 'CONFIRMED' },
    orderBy: { createdAt: 'asc' },
  });
  const buysBefore = trades.filter(
    (t) => t.side === 'BUY' && t.createdAt.getTime() <= position.createdAt.getTime(),
  );
  const buyTrade = buysBefore.length > 0 ? buysBefore[buysBefore.length - 1]! : undefined;
  const sellTrades = position.closedAt
    ? trades.filter(
        (t) =>
          t.side === 'SELL' &&
          t.createdAt.getTime() >= position.createdAt.getTime() &&
          t.createdAt.getTime() <= position.closedAt!.getTime(),
      )
    : [];
  return { buyTrade, sellTrades };
}

async function main() {
  const batchId = `pnlrecon_${new Date().toISOString().replace(/[:.]/g, '-')}`;
  console.log(`Mode: ${EXECUTE ? 'EXECUTE (writes will be applied)' : 'DRY RUN (no writes)'}`);
  console.log(`Batch ID: ${batchId}\n`);

  const closedPositions = await prisma.position.findMany({
    where: { status: 'CLOSED' },
    include: { token: true },
    orderBy: { createdAt: 'asc' },
  });

  const auditRows: AuditRow[] = [];
  const positionCorrections: PositionCorrection[] = [];
  const tokenCorrectionsByTokenId = new Map<string, TokenCorrection>();
  let skippedPaperTrades = 0;
  let skippedUnresolved = 0;
  let skippedNoRealDecimals = 0;

  for (const pos of closedPositions) {
    const mint = pos.token.mint;
    if (mint.startsWith('SIMTEST')) {
      skippedPaperTrades++;
      continue;
    }
    const realDecimals = REAL_DECIMALS[mint];
    if (realDecimals === undefined) {
      console.warn(`No verified real decimals for mint ${mint} (position ${pos.id}) — skipping`);
      skippedNoRealDecimals++;
      continue;
    }

    if (pos.token.decimals !== realDecimals && !tokenCorrectionsByTokenId.has(pos.token.id)) {
      tokenCorrectionsByTokenId.set(pos.token.id, {
        tokenId: pos.token.id,
        mint,
        oldDecimals: pos.token.decimals,
        newDecimals: realDecimals,
      });
    }

    const { buyTrade, sellTrades } = await matchTrades(pos);
    if (!buyTrade || sellTrades.length === 0) {
      // No resolvable sell (zero-balance/rug reconciliation, or a genuinely
      // unmatched buy) — stored realizedPnlUsd is already null in every such
      // case per the prior audit; nothing to correct, nothing was ever claimed.
      skippedUnresolved++;
      continue;
    }

    const totalBuySol = buyTrade.amountSol;
    const totalSellSol = sellTrades.reduce((s, t) => s + t.amountSol, 0);
    const realPnlSol = totalSellSol - totalBuySol;

    // Implied historical SOL/USD price from the sell trade(s)' OWN recorded
    // priceUsd (a market quote, independent of the decimals bug) combined
    // with the REAL decimals-adjusted token amount — weighted by amountSol
    // for positions with more than one confirmed sell (partial exits).
    let weightedSum = 0;
    let weightTotal = 0;
    for (const st of sellTrades) {
      if (st.priceUsd !== null && st.amountSol > 0) {
        const usdValue = st.priceUsd * (st.amountToken / 10 ** realDecimals);
        const impliedSolPriceUsd = usdValue / st.amountSol;
        weightedSum += impliedSolPriceUsd * st.amountSol;
        weightTotal += st.amountSol;
      }
    }
    if (weightTotal <= 0) continue; // no usable price data — leave untouched, don't guess
    const impliedSolPriceUsd = weightedSum / weightTotal;
    const newRealizedPnlUsd = realPnlSol * impliedSolPriceUsd;

    const oldValue = pos.realizedPnlUsd;
    if (oldValue !== null && Math.abs(newRealizedPnlUsd - oldValue) <= MATERIAL_DIFF_USD) {
      continue; // already correct, nothing to do
    }

    positionCorrections.push({
      positionId: pos.id,
      mint,
      symbol: pos.token.symbol,
      oldRealizedPnlUsd: oldValue,
      newRealizedPnlUsd,
      realPnlSol,
      totalBuySol,
      totalSellSol,
    });
  }

  const tokenCorrections = [...tokenCorrectionsByTokenId.values()];

  // --- Fee ledger / referral corrections, derived from position corrections ---
  const correctionByPositionId = new Map(positionCorrections.map((c) => [c.positionId, c]));
  const feeLedgerRows = await prisma.performanceFeeLedger.findMany({
    where: { positionId: { in: [...correctionByPositionId.keys()] } },
  });
  const feeLedgerCorrections: Array<{
    id: string;
    oldGrossProfitUsd: number;
    newGrossProfitUsd: number;
    oldFeeUsd: number;
    newFeeUsd: number;
    oldUserShareUsd: number;
    newUserShareUsd: number;
    oldNetProfitUsd: number;
    newNetProfitUsd: number;
  }> = [];
  for (const row of feeLedgerRows) {
    const correction = correctionByPositionId.get(row.positionId)!;
    const newGrossProfitUsd = correction.newRealizedPnlUsd;
    const newNetProfitUsd = newGrossProfitUsd - row.tradingCostsUsd;
    const newFeeUsd = newNetProfitUsd * (row.feeBps / 10_000);
    const newUserShareUsd = newNetProfitUsd - newFeeUsd;
    feeLedgerCorrections.push({
      id: row.id,
      oldGrossProfitUsd: row.grossProfitUsd,
      newGrossProfitUsd,
      oldFeeUsd: row.feeUsd,
      newFeeUsd,
      oldUserShareUsd: row.userShareUsd,
      newUserShareUsd,
      oldNetProfitUsd: row.netProfitUsd,
      newNetProfitUsd,
    });
  }
  const feeLedgerCorrectionById = new Map(feeLedgerCorrections.map((c) => [c.id, c]));
  const referralRows = await prisma.referralReward.findMany({
    where: { performanceFeeLedgerId: { in: feeLedgerCorrections.map((c) => c.id) } },
  });
  const referralCorrections: Array<{ id: string; oldRewardUsd: number; newRewardUsd: number }> = [];
  for (const row of referralRows) {
    const feeCorrection = feeLedgerCorrectionById.get(row.performanceFeeLedgerId)!;
    const newRewardUsd = feeCorrection.newFeeUsd * (row.percentBps / 10_000);
    referralCorrections.push({ id: row.id, oldRewardUsd: row.rewardUsd, newRewardUsd });
  }

  // --- Report ---
  console.log(`Closed positions examined: ${closedPositions.length}`);
  console.log(`  Paper trades (skipped): ${skippedPaperTrades}`);
  console.log(
    `  Unresolved / no matched sell (skipped, no PnL was ever claimed): ${skippedUnresolved}`,
  );
  console.log(`  No verified real decimals available (skipped): ${skippedNoRealDecimals}`);
  console.log(`\nToken.decimals corrections: ${tokenCorrections.length}`);
  for (const c of tokenCorrections) {
    console.log(`  ${c.mint} (${c.tokenId}): ${c.oldDecimals} -> ${c.newDecimals}`);
  }

  console.log(`\nPosition.realizedPnlUsd corrections: ${positionCorrections.length}`);
  for (const c of positionCorrections) {
    console.log(
      `  ${c.positionId} ${(c.symbol ?? '(none)').padEnd(10)} old=${c.oldRealizedPnlUsd} new=${c.newRealizedPnlUsd.toFixed(8)} (realPnlSol=${c.realPnlSol.toFixed(6)}, buy=${c.totalBuySol}, sell=${c.totalSellSol})`,
    );
  }

  console.log(`\nperformance_fee_ledger corrections: ${feeLedgerCorrections.length}`);
  for (const c of feeLedgerCorrections) {
    console.log(
      `  ${c.id}: grossProfitUsd ${c.oldGrossProfitUsd} -> ${c.newGrossProfitUsd.toFixed(8)}, feeUsd ${c.oldFeeUsd} -> ${c.newFeeUsd.toFixed(8)}, userShareUsd ${c.oldUserShareUsd} -> ${c.newUserShareUsd.toFixed(8)}`,
    );
  }

  console.log(`\nreferral_rewards corrections: ${referralCorrections.length}`);
  for (const c of referralCorrections) {
    console.log(`  ${c.id}: rewardUsd ${c.oldRewardUsd} -> ${c.newRewardUsd.toFixed(8)}`);
  }

  // --- Verification totals (must match the prior audit) ---
  const usohCorrections = positionCorrections.filter(
    (c) => c.mint === 'YPcvyLXwAFVRhyT7AHirVUrVg6HkpTMpSSRMENmpump',
  );
  const usohTotalRealPnlSol = usohCorrections.reduce((s, c) => s + c.realPnlSol, 0);
  const platformTotalRealPnlSol = positionCorrections.reduce((s, c) => s + c.realPnlSol, 0);
  // Include already-correct positions' real PnL too (USDC/BONK ones weren't
  // "corrected" because they were already right, but they're still part of
  // the platform-wide resolvable-position total from the prior audit).
  console.log(`\n--- Verification against the prior audit ---`);
  console.log(
    `USOH total real PnL (SOL), corrected positions only: ${usohTotalRealPnlSol.toFixed(6)}`,
  );
  console.log(
    `Platform-wide total real PnL (SOL), corrected positions only: ${platformTotalRealPnlSol.toFixed(6)}`,
  );
  console.log(
    `(Expected approx: USOH -0.372 SOL, platform -0.457 SOL across all 32 resolvable positions —`,
  );
  console.log(
    ` the platform figure above covers only the ${positionCorrections.length} positions whose stored`,
  );
  console.log(` value actually needed correction; already-correct ones are excluded by design.)`);

  // --- Build audit log rows ---
  for (const c of tokenCorrections) {
    auditRows.push({
      tableName: 'tokens',
      recordId: c.tokenId,
      fieldName: 'decimals',
      oldValue: String(c.oldDecimals),
      newValue: String(c.newDecimals),
      reason: `Backfilled to real on-chain decimals for mint ${c.mint} (verified via Helius RPC 2026-07-23) — was the Prisma schema's @default(9) fallback, never populated from chain.`,
    });
  }
  for (const c of positionCorrections) {
    auditRows.push({
      tableName: 'positions',
      recordId: c.positionId,
      fieldName: 'realizedPnlUsd',
      oldValue: String(c.oldRealizedPnlUsd),
      newValue: String(c.newRealizedPnlUsd),
      reason: `Recomputed from real confirmed BUY/SELL trade data (buy=${c.totalBuySol} SOL, sell=${c.totalSellSol} SOL, realPnlSol=${c.realPnlSol}) and real on-chain decimals — 2026-07-23 USOH incident historical reconciliation.`,
    });
  }
  for (const c of feeLedgerCorrections) {
    auditRows.push(
      {
        tableName: 'performance_fee_ledger',
        recordId: c.id,
        fieldName: 'grossProfitUsd',
        oldValue: String(c.oldGrossProfitUsd),
        newValue: String(c.newGrossProfitUsd),
        reason:
          'Derived from corrected Position.realizedPnlUsd — 2026-07-23 historical reconciliation.',
      },
      {
        tableName: 'performance_fee_ledger',
        recordId: c.id,
        fieldName: 'netProfitUsd',
        oldValue: String(c.oldNetProfitUsd),
        newValue: String(c.newNetProfitUsd),
        reason:
          'Derived from corrected grossProfitUsd (tradingCostsUsd unchanged) — 2026-07-23 historical reconciliation.',
      },
      {
        tableName: 'performance_fee_ledger',
        recordId: c.id,
        fieldName: 'feeUsd',
        oldValue: String(c.oldFeeUsd),
        newValue: String(c.newFeeUsd),
        reason:
          'Derived from corrected netProfitUsd x feeBps — 2026-07-23 historical reconciliation. No real payout was ever executed for this row (payoutTxSignature is null).',
      },
      {
        tableName: 'performance_fee_ledger',
        recordId: c.id,
        fieldName: 'userShareUsd',
        oldValue: String(c.oldUserShareUsd),
        newValue: String(c.newUserShareUsd),
        reason:
          'Derived from corrected netProfitUsd - feeUsd — 2026-07-23 historical reconciliation.',
      },
    );
  }
  for (const c of referralCorrections) {
    auditRows.push({
      tableName: 'referral_rewards',
      recordId: c.id,
      fieldName: 'rewardUsd',
      oldValue: String(c.oldRewardUsd),
      newValue: String(c.newRewardUsd),
      reason:
        'Derived from corrected performance_fee_ledger.feeUsd x percentBps — 2026-07-23 historical reconciliation. No real payout was ever executed for this row (payoutTxSignature is null).',
    });
  }

  console.log(`\nTotal audit log rows that would be written: ${auditRows.length}`);

  if (!EXECUTE) {
    console.log('\nDRY RUN — no database writes performed.');
    return;
  }

  console.log('\nEXECUTING — applying corrections in a single transaction...');
  await prisma.$transaction(async (tx) => {
    for (const row of auditRows) {
      await tx.pnlReconciliationLog.create({ data: { ...row, batchId } });
    }
    for (const c of tokenCorrections) {
      await tx.token.update({ where: { id: c.tokenId }, data: { decimals: c.newDecimals } });
    }
    for (const c of positionCorrections) {
      await tx.position.update({
        where: { id: c.positionId },
        data: { realizedPnlUsd: c.newRealizedPnlUsd },
      });
    }
    for (const c of feeLedgerCorrections) {
      await tx.performanceFeeLedger.update({
        where: { id: c.id },
        data: {
          grossProfitUsd: c.newGrossProfitUsd,
          netProfitUsd: c.newNetProfitUsd,
          feeUsd: c.newFeeUsd,
          userShareUsd: c.newUserShareUsd,
        },
      });
    }
    for (const c of referralCorrections) {
      await tx.referralReward.update({ where: { id: c.id }, data: { rewardUsd: c.newRewardUsd } });
    }
  });
  console.log(`Done. Batch ID for this run: ${batchId}`);
  console.log(
    `Query audit trail: SELECT * FROM pnl_reconciliation_log WHERE "batchId" = '${batchId}';`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
