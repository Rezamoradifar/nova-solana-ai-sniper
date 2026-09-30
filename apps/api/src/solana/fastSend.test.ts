import { describe, expect, it, vi } from 'vitest';
import { Keypair, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { sprayTransaction, type RawSender } from './fastSend.js';
import { broadcastTransaction } from './broadcast.js';

const ok = (label: string): RawSender => ({ label, send: vi.fn().mockResolvedValue(undefined) });
const bad = (label: string): RawSender => ({
  label,
  send: vi.fn().mockRejectedValue(new Error('nope')),
});

function fakeTransaction(): VersionedTransaction {
  const payer = Keypair.generate();
  const tx = new VersionedTransaction(
    new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: Keypair.generate().publicKey.toBase58(),
      instructions: [],
    }).compileToV0Message(),
  );
  tx.sign([payer]);
  return tx;
}
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

describe('sprayTransaction', () => {
  it('sends to every endpoint and succeeds if at least one accepts', async () => {
    const a = ok('a');
    const b = bad('b');
    expect(await sprayTransaction(new Uint8Array([1]), [a, b])).toEqual(['a']);
    expect(a.send).toHaveBeenCalledTimes(1);
    expect(b.send).toHaveBeenCalledTimes(1);
  });

  it('throws only when every endpoint refuses', async () => {
    await expect(sprayTransaction(new Uint8Array([1]), [bad('a'), bad('b')])).rejects.toThrow(
      /every endpoint refused/,
    );
  });
});

describe('broadcastTransaction fast path', () => {
  it('sprays the same bytes to all senders, skips the single-RPC send, and confirms', async () => {
    const a = ok('a');
    const b = ok('b');
    const connection = {
      sendTransaction: vi.fn(),
      confirmTransaction: vi.fn().mockResolvedValue({ value: { err: null } }),
    };
    const tx = fakeTransaction();
    const sig = await broadcastTransaction(
      {
        connection: connection as never,
        logger,
        fastSend: { senders: [a, b], rebroadcastMs: 60_000 },
      },
      tx,
      Keypair.generate(),
    );
    expect(typeof sig).toBe('string');
    expect(connection.sendTransaction).not.toHaveBeenCalled();
    const sentA = (a.send as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    const sentB = (b.send as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(Buffer.from(sentA).equals(Buffer.from(sentB))).toBe(true);
  });

  it('still reports an on-chain revert', async () => {
    const connection = {
      confirmTransaction: vi.fn().mockResolvedValue({ value: { err: 'Custom' } }),
    };
    await expect(
      broadcastTransaction(
        {
          connection: connection as never,
          logger,
          fastSend: { senders: [ok('a')], rebroadcastMs: 60_000 },
        },
        fakeTransaction(),
        Keypair.generate(),
      ),
    ).rejects.toThrow(/reverted on-chain/);
  });

  it('pays the Jito tip with the swap blockhash (no extra RPC round trip)', async () => {
    const connection = {
      getLatestBlockhash: vi.fn(),
      confirmTransaction: vi.fn().mockResolvedValue({ value: { err: null } }),
    };
    const jito = { sendBundle: vi.fn().mockResolvedValue('bundle') };
    await broadcastTransaction(
      {
        connection: connection as never,
        logger,
        jito: jito as never,
        fastSend: { senders: [ok('a')], rebroadcastMs: 60_000 },
      },
      fakeTransaction(),
      Keypair.generate(),
    );
    expect(connection.getLatestBlockhash).not.toHaveBeenCalled();
    expect(jito.sendBundle).toHaveBeenCalledTimes(1);
  });
});
