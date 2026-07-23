import { describe, expect, it } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import {
  buildTransferInstructions,
  decidePayoutAction,
  evaluatePayoutBalanceSufficiency,
  resolvePayoutRecipients,
} from './payoutCalculation.js';

const TREASURY = Keypair.generate().publicKey.toBase58();
const REFERRER_1 = Keypair.generate().publicKey.toBase58();
const REFERRER_2 = Keypair.generate().publicKey.toBase58();

describe('resolvePayoutRecipients', () => {
  it('converts USD to lamports at the given SOL price for both a referrer and the platform share', () => {
    // $10 platform share at $100/SOL => 0.1 SOL => 100_000_000 lamports.
    const result = resolvePayoutRecipients({
      referralRewards: [],
      platformShareUsd: 10,
      treasuryAddress: TREASURY,
      solPriceUsd: 100,
    });
    expect(result.recipients).toEqual([{ toAddress: TREASURY, lamports: 100_000_000n }]);
    expect(result.totalLamports).toBe(100_000_000n);
    expect(result.referralOutcomes).toEqual([]);
  });

  it('pays a referrer with a resolved wallet directly, as a separate recipient from the treasury', () => {
    const result = resolvePayoutRecipients({
      referralRewards: [
        { referrerUserId: 'u1', level: 1, rewardUsd: 5, payoutPublicKey: REFERRER_1 },
      ],
      platformShareUsd: 5,
      treasuryAddress: TREASURY,
      solPriceUsd: 100,
    });
    expect(result.recipients).toEqual(
      expect.arrayContaining([
        { toAddress: REFERRER_1, lamports: 50_000_000n },
        { toAddress: TREASURY, lamports: 50_000_000n },
      ]),
    );
    expect(result.recipients).toHaveLength(2);
    expect(result.referralOutcomes).toEqual([
      { referrerUserId: 'u1', level: 1, toAddress: REFERRER_1, rolledUpToTreasury: false },
    ]);
  });

  it('rolls a referrer with no resolvable wallet into the treasury payment, never dropping the share', () => {
    const result = resolvePayoutRecipients({
      referralRewards: [
        { referrerUserId: 'u1', level: 1, rewardUsd: 5, payoutPublicKey: undefined },
      ],
      platformShareUsd: 5,
      treasuryAddress: TREASURY,
      solPriceUsd: 100,
    });
    // Both the rolled-up referral share and the platform's own share go to
    // the SAME address — merged into exactly one recipient.
    expect(result.recipients).toEqual([{ toAddress: TREASURY, lamports: 100_000_000n }]);
    expect(result.referralOutcomes).toEqual([
      { referrerUserId: 'u1', level: 1, toAddress: TREASURY, rolledUpToTreasury: true },
    ]);
  });

  it('merges two amounts bound for the same address into one instruction (a referrer wallet happens to equal another destination)', () => {
    const result = resolvePayoutRecipients({
      referralRewards: [
        { referrerUserId: 'u1', level: 1, rewardUsd: 5, payoutPublicKey: REFERRER_1 },
        { referrerUserId: 'u2', level: 2, rewardUsd: 2, payoutPublicKey: REFERRER_1 }, // same wallet as L1
      ],
      platformShareUsd: 3,
      treasuryAddress: TREASURY,
      solPriceUsd: 100,
    });
    expect(result.recipients).toEqual(
      expect.arrayContaining([
        { toAddress: REFERRER_1, lamports: 70_000_000n }, // (5+2)/100 SOL
        { toAddress: TREASURY, lamports: 30_000_000n },
      ]),
    );
    expect(result.recipients).toHaveLength(2);
  });

  it('produces zero recipients when there is nothing to pay', () => {
    const result = resolvePayoutRecipients({
      referralRewards: [],
      platformShareUsd: 0,
      treasuryAddress: TREASURY,
      solPriceUsd: 100,
    });
    expect(result.recipients).toEqual([]);
    expect(result.totalLamports).toBe(0n);
  });

  it('handles a full L1+L2+platform breakdown with distinct wallets', () => {
    const result = resolvePayoutRecipients({
      referralRewards: [
        { referrerUserId: 'u1', level: 1, rewardUsd: 10, payoutPublicKey: REFERRER_1 },
        { referrerUserId: 'u2', level: 2, rewardUsd: 5, payoutPublicKey: REFERRER_2 },
      ],
      platformShareUsd: 5,
      treasuryAddress: TREASURY,
      solPriceUsd: 100,
    });
    expect(result.recipients).toHaveLength(3);
    expect(result.totalLamports).toBe(200_000_000n); // (10+5+5)/100 SOL
  });
});

describe('evaluatePayoutBalanceSufficiency', () => {
  it('allows when balance covers payout + fee + reserve exactly', () => {
    expect(evaluatePayoutBalanceSufficiency(1_000_000n, 800_000n, 100_000n, 100_000n)).toEqual({
      allowed: true,
    });
  });

  it('blocks when balance is short by even 1 lamport', () => {
    const result = evaluatePayoutBalanceSufficiency(999_999n, 800_000n, 100_000n, 100_000n);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('below the');
  });

  it('blocks when there is nothing to pay against but the reserve alone', () => {
    expect(evaluatePayoutBalanceSufficiency(0n, 500_000n, 5_000n, 10_000n).allowed).toBe(false);
  });
});

describe('decidePayoutAction', () => {
  const now = Date.now();
  const staleMs = 10 * 60 * 1000;

  it('starts fresh when no attempt exists yet', () => {
    expect(decidePayoutAction(null, now, staleMs)).toEqual({ action: 'start' });
  });

  it('treats CONFIRMED as already done', () => {
    expect(
      decidePayoutAction({ status: 'CONFIRMED', processingStartedAt: new Date(now) }, now, staleMs),
    ).toEqual({ action: 'skip_already_done' });
  });

  it('treats every terminal SKIPPED_*/FAILED status as already done', () => {
    for (const status of [
      'FAILED',
      'SKIPPED_INSUFFICIENT_BALANCE',
      'SKIPPED_PAPER_TRADE',
      'SKIPPED_NO_PAYOUT_NEEDED',
    ] as const) {
      expect(
        decidePayoutAction({ status, processingStartedAt: new Date(now) }, now, staleMs),
      ).toEqual({
        action: 'skip_already_done',
      });
    }
  });

  it('defers silently on a fresh concurrent PENDING/SUBMITTED attempt', () => {
    const fresh = new Date(now - 60_000); // 1 minute old
    expect(
      decidePayoutAction({ status: 'PENDING', processingStartedAt: fresh }, now, staleMs),
    ).toEqual({
      action: 'skip_concurrent_in_progress',
    });
    expect(
      decidePayoutAction({ status: 'SUBMITTED', processingStartedAt: fresh }, now, staleMs),
    ).toEqual({
      action: 'skip_concurrent_in_progress',
    });
  });

  it('alerts as stuck once a PENDING/SUBMITTED attempt exceeds staleMs', () => {
    const stale = new Date(now - staleMs - 1);
    expect(
      decidePayoutAction({ status: 'PENDING', processingStartedAt: stale }, now, staleMs),
    ).toEqual({
      action: 'alert_stuck',
    });
    expect(
      decidePayoutAction({ status: 'SUBMITTED', processingStartedAt: stale }, now, staleMs),
    ).toEqual({
      action: 'alert_stuck',
    });
  });

  it('is exactly at the boundary: still concurrent one ms before staleMs, stuck exactly at staleMs', () => {
    const justBelow = new Date(now - (staleMs - 1));
    const exactly = new Date(now - staleMs);
    expect(
      decidePayoutAction({ status: 'PENDING', processingStartedAt: justBelow }, now, staleMs)
        .action,
    ).toBe('skip_concurrent_in_progress');
    expect(
      decidePayoutAction({ status: 'PENDING', processingStartedAt: exactly }, now, staleMs).action,
    ).toBe('alert_stuck');
  });
});

describe('buildTransferInstructions', () => {
  it('builds exactly one SystemProgram.transfer instruction per recipient, with the correct fields', () => {
    const from = Keypair.generate().publicKey;
    const instructions = buildTransferInstructions(from, [
      { toAddress: TREASURY, lamports: 12345n },
      { toAddress: REFERRER_1, lamports: 999n },
    ]);
    expect(instructions).toHaveLength(2);
    for (const ix of instructions) {
      expect(ix.keys[0]!.pubkey.equals(from)).toBe(true);
      expect(ix.keys[0]!.isSigner).toBe(true);
    }
    expect(instructions[0]!.keys[1]!.pubkey.equals(new PublicKey(TREASURY))).toBe(true);
    expect(instructions[1]!.keys[1]!.pubkey.equals(new PublicKey(REFERRER_1))).toBe(true);
  });

  it('builds zero instructions for zero recipients', () => {
    expect(buildTransferInstructions(Keypair.generate().publicKey, [])).toEqual([]);
  });
});
