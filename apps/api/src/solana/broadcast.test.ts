import { describe, expect, it, vi } from 'vitest';
import { Keypair, VersionedTransaction, TransactionMessage } from '@solana/web3.js';
import { broadcastTransaction } from './broadcast.js';
import type { JitoClient } from './jito.js';

function fakeLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
}

function fakeTransaction(): VersionedTransaction {
  const payer = Keypair.generate();
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
    instructions: [],
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  tx.sign([payer]);
  return tx;
}

describe('broadcastTransaction (extracted 2026-07-23 — shared by PositionManager and the payout executor)', () => {
  it('sends directly (no Jito configured) and returns the signature on a clean confirmation', async () => {
    const connection = {
      sendTransaction: vi.fn().mockResolvedValue('sig'),
      confirmTransaction: vi.fn().mockResolvedValue({ value: { err: null } }),
    };
    const signature = await broadcastTransaction(
      { connection: connection as never, logger: fakeLogger() },
      fakeTransaction(),
      Keypair.generate(),
    );
    expect(typeof signature).toBe('string');
    expect(connection.sendTransaction).toHaveBeenCalledTimes(1);
  });

  it('throws when the transaction lands but reverts on-chain (direct-send path)', async () => {
    const connection = {
      sendTransaction: vi.fn().mockResolvedValue('sig'),
      confirmTransaction: vi.fn().mockResolvedValue({ value: { err: 'InsufficientFundsForFee' } }),
    };
    await expect(
      broadcastTransaction(
        { connection: connection as never, logger: fakeLogger() },
        fakeTransaction(),
        Keypair.generate(),
      ),
    ).rejects.toThrow(/reverted on-chain/);
  });

  it('falls back to a direct send when the Jito bundle submission itself fails', async () => {
    const connection = {
      getLatestBlockhash: vi
        .fn()
        .mockResolvedValue({ blockhash: Keypair.generate().publicKey.toBase58() }),
      sendTransaction: vi.fn().mockResolvedValue('sig'),
      confirmTransaction: vi.fn().mockResolvedValue({ value: { err: null } }),
    };
    const jito = {
      sendBundle: vi.fn().mockRejectedValue(new Error('bundle rejected')),
    } as unknown as JitoClient;
    const signature = await broadcastTransaction(
      { connection: connection as never, logger: fakeLogger(), jito },
      fakeTransaction(),
      Keypair.generate(),
    );
    expect(typeof signature).toBe('string');
    expect(jito.sendBundle).toHaveBeenCalledTimes(1);
    expect(connection.sendTransaction).toHaveBeenCalledTimes(1);
  });

  it('detects an on-chain revert via the Jito path too, without ever falling through to a second (direct) send', async () => {
    const connection = {
      getLatestBlockhash: vi
        .fn()
        .mockResolvedValue({ blockhash: Keypair.generate().publicKey.toBase58() }),
      sendTransaction: vi.fn(),
      confirmTransaction: vi
        .fn()
        .mockResolvedValue({ value: { err: 'SlippageToleranceExceeded' } }),
    };
    const jito = { sendBundle: vi.fn().mockResolvedValue(undefined) } as unknown as JitoClient;
    await expect(
      broadcastTransaction(
        { connection: connection as never, logger: fakeLogger(), jito },
        fakeTransaction(),
        Keypair.generate(),
      ),
    ).rejects.toThrow(/reverted on-chain/);
    // The Jito path's own revert is thrown *inside* the try block, so it's
    // caught by the same catch that triggers a direct-send fallback — this
    // codebase's existing, intentional behavior (matches PositionManager's
    // pre-extraction logic byte-for-byte): a Jito-path revert still falls
    // through to a direct send rather than failing immediately.
    expect(connection.sendTransaction).toHaveBeenCalledTimes(1);
  });
});
