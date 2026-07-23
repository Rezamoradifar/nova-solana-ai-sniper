import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';

const REAL_KEYPAIR = Keypair.generate();

vi.mock('@nova/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nova/shared')>();
  return { ...actual, unsealKeypair: vi.fn(() => REAL_KEYPAIR) };
});

vi.mock('../solana/broadcast.js', () => ({
  broadcastTransaction: vi.fn().mockResolvedValue('mock-signature-should-be-overridden-per-test'),
}));

import { unsealKeypair } from '@nova/shared';
import { broadcastTransaction } from '../solana/broadcast.js';
import {
  executeReferralAndPlatformPayout,
  type PayoutExecutorDeps,
  type PayoutParams,
} from './payoutExecutor.js';

function fakeLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
}

const TREASURY = Keypair.generate().publicKey.toBase58();
const REFERRER_WALLET = Keypair.generate().publicKey.toBase58();
const TRADER_WALLET = REAL_KEYPAIR.publicKey.toBase58();

function fakePrisma(
  overrides: {
    existingAttempt?: Record<string, unknown> | null;
    createImpl?: ReturnType<typeof vi.fn>;
    updateImpl?: ReturnType<typeof vi.fn>;
  } = {},
) {
  return {
    payoutAttempt: {
      create:
        overrides.createImpl ?? vi.fn().mockResolvedValue({ id: 'attempt-1', status: 'PENDING' }),
      findUnique: vi.fn().mockResolvedValue(overrides.existingAttempt ?? null),
      update: overrides.updateImpl ?? vi.fn().mockResolvedValue({}),
    },
  } as never;
}

function baseParams(overrides: Partial<PayoutParams> = {}): PayoutParams {
  return {
    positionId: 'pos-1',
    walletId: 'wallet-1',
    walletPublicKey: TRADER_WALLET,
    encryptedSecret: 'encrypted-secret',
    referralRewards: [
      { referrerUserId: 'ref-1', level: 1, rewardUsd: 5, payoutPublicKey: REFERRER_WALLET },
    ],
    platformShareUsd: 5,
    ...overrides,
  };
}

function baseDeps(overrides: Partial<PayoutExecutorDeps> = {}): PayoutExecutorDeps {
  return {
    prisma: fakePrisma(),
    connection: {
      getBalance: vi.fn().mockResolvedValue(10 * 1_000_000_000), // 10 SOL
      getLatestBlockhash: vi.fn().mockResolvedValue({
        blockhash: Keypair.generate().publicKey.toBase58(),
        lastValidBlockHeight: 100,
      }),
    } as never,
    logger: fakeLogger(),
    encryptionKey: 'key',
    treasuryAddress: TREASURY,
    minWalletReserveSol: 0.01,
    staleMs: 10 * 60 * 1000,
    getSolPriceUsd: vi.fn().mockResolvedValue(100),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(broadcastTransaction).mockResolvedValue('default-mock-signature');
});

describe('executeReferralAndPlatformPayout', () => {
  it('happy path: creates a PENDING attempt, submits with the real (locally-signed) signature before broadcast, then confirms', async () => {
    const update = vi.fn().mockResolvedValue({});
    const deps = baseDeps({ prisma: fakePrisma({ updateImpl: update }) });

    const outcome = await executeReferralAndPlatformPayout(deps, baseParams());

    expect(outcome.kind).toBe('confirmed');
    if (outcome.kind === 'confirmed') {
      // The signature is computed locally at sign-time, independent of
      // whatever broadcastTransaction itself returns — this is the actual
      // ordering guarantee (see schema.prisma's PayoutAttempt doc comment):
      // the signature must be known and durably recorded BEFORE broadcast.
      expect(outcome.txSignature).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/); // valid base58
      expect(outcome.recipients).toHaveLength(2); // referrer + treasury
    }
    // SUBMITTED (with the signature) must be written BEFORE broadcastTransaction resolves —
    // asserted here by call ordering: update is called with SUBMITTED, then CONFIRMED.
    const statuses = update.mock.calls.map(
      (c) => (c[0] as { data: { status: string } }).data.status,
    );
    expect(statuses).toEqual(['SUBMITTED', 'CONFIRMED']);
    expect(update.mock.calls[0]![0].data.txSignature).toBeTruthy();
    expect(update.mock.calls[0]![0].data.txSignature).toBe(
      (outcome as { txSignature: string }).txSignature,
    );
    expect(unsealKeypair).toHaveBeenCalledWith('encrypted-secret', 'key');
  });

  it('is a no-op (skipped, no DB writes) when there is genuinely nothing to pay', async () => {
    const create = vi.fn();
    const deps = baseDeps({ prisma: fakePrisma({ createImpl: create }) });
    const outcome = await executeReferralAndPlatformPayout(
      deps,
      baseParams({ referralRewards: [], platformShareUsd: 0 }),
    );
    expect(outcome).toEqual({ kind: 'skipped', reason: 'no_payout_needed' });
    expect(create).not.toHaveBeenCalled();
  });

  it('defers silently on a fresh concurrent duplicate (P2002, attempt still young)', async () => {
    const create = vi.fn().mockRejectedValue({ code: 'P2002' });
    const deps = baseDeps({
      prisma: fakePrisma({
        createImpl: create,
        existingAttempt: {
          status: 'PENDING',
          processingStartedAt: new Date(Date.now() - 30_000),
          txSignature: null,
        },
      }),
    });
    const notifyError = vi.fn();
    deps.notifier = { notifyError } as never;

    const outcome = await executeReferralAndPlatformPayout(deps, baseParams());

    expect(outcome).toEqual({ kind: 'deferred' });
    expect(notifyError).not.toHaveBeenCalled();
  });

  it('alerts loudly on a stale stuck concurrent attempt, without touching it further', async () => {
    const create = vi.fn().mockRejectedValue({ code: 'P2002' });
    const staleMs = 10 * 60 * 1000;
    const deps = baseDeps({
      prisma: fakePrisma({
        createImpl: create,
        existingAttempt: {
          status: 'SUBMITTED',
          processingStartedAt: new Date(Date.now() - staleMs - 1000),
          txSignature: 'old-sig',
        },
      }),
      staleMs,
    });
    const notifyError = vi.fn();
    deps.notifier = { notifyError } as never;

    const outcome = await executeReferralAndPlatformPayout(deps, baseParams());

    expect(outcome).toEqual({ kind: 'deferred' });
    expect(notifyError).toHaveBeenCalledTimes(1);
    expect(notifyError.mock.calls[0]![1]).toContain('old-sig');
  });

  it('skips (terminal) with a loud alert when the trader wallet balance cannot cover payout + fee + reserve — never partially pays', async () => {
    const update = vi.fn().mockResolvedValue({});
    const deps = baseDeps({
      prisma: fakePrisma({ updateImpl: update }),
      connection: { getBalance: vi.fn().mockResolvedValue(1000) } as never, // far too little
    });
    const notifyError = vi.fn();
    deps.notifier = { notifyError } as never;

    const outcome = await executeReferralAndPlatformPayout(deps, baseParams());

    expect(outcome).toEqual({ kind: 'skipped', reason: 'insufficient_balance' });
    expect(update.mock.calls[0]![0].data.status).toBe('SKIPPED_INSUFFICIENT_BALANCE');
    expect(notifyError).toHaveBeenCalledTimes(1);
    expect(broadcastTransaction).not.toHaveBeenCalled();
  });

  it('marks FAILED (never CONFIRMED) and alerts when the broadcast itself throws — the attempt stays at SUBMITTED->FAILED, never silently lost', async () => {
    vi.mocked(broadcastTransaction).mockRejectedValueOnce(new Error('reverted on-chain'));
    const update = vi.fn().mockResolvedValue({});
    const deps = baseDeps({ prisma: fakePrisma({ updateImpl: update }) });
    const notifyError = vi.fn();
    deps.notifier = { notifyError } as never;

    const outcome = await executeReferralAndPlatformPayout(deps, baseParams());

    expect(outcome.kind).toBe('failed');
    const statuses = update.mock.calls.map(
      (c) => (c[0] as { data: { status: string } }).data.status,
    );
    expect(statuses).toEqual(['SUBMITTED', 'FAILED']);
    expect(notifyError).toHaveBeenCalledTimes(1);
  });

  it('rolls a referrer with no resolvable wallet into the treasury payment rather than skipping their share', async () => {
    vi.mocked(broadcastTransaction).mockResolvedValueOnce('sig-rollup');
    const deps = baseDeps();
    const outcome = await executeReferralAndPlatformPayout(
      deps,
      baseParams({
        referralRewards: [
          { referrerUserId: 'ref-1', level: 1, rewardUsd: 5, payoutPublicKey: undefined },
        ],
      }),
    );
    expect(outcome.kind).toBe('confirmed');
    if (outcome.kind === 'confirmed') {
      expect(outcome.recipients).toHaveLength(1); // rolled-up + platform share merge into treasury
      expect(outcome.referralOutcomes[0]!.rolledUpToTreasury).toBe(true);
    }
  });
});
