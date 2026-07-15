import { Keypair, VersionedTransaction, TransactionMessage } from '@solana/web3.js';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { JupiterClient, SOL_MINT } from './jupiter.js';
import { latencyTracker } from '../lib/latencyTracker.js';

beforeEach(() => {
  latencyTracker.reset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function fakeSwapTransactionBase64(payerKey: import('@solana/web3.js').PublicKey): string {
  const message = new TransactionMessage({
    payerKey,
    // A blockhash is structurally just a 32-byte base58 value, same shape as
    // a public key — any real Keypair's pubkey satisfies the encoder here.
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
    instructions: [],
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  return Buffer.from(tx.serialize()).toString('base64');
}

/** payerKey must match whichever Keypair the test later signs with (prepareSwap
 * calls transaction.sign([signer]), which requires signer to be a required
 * signer of the transaction it's signing — i.e. the fee payer here). */
function stubJupiterFetch(payerKey: import('@solana/web3.js').PublicKey): void {
  const swapTransaction = fakeSwapTransactionBase64(payerKey);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL) => {
      const url = input.toString();
      if (url.includes('/swap/v1/quote')) {
        return new Response(
          JSON.stringify({
            inAmount: '1000',
            outAmount: '2000',
            priceImpactPct: '0',
            routePlan: [],
          }),
          { status: 200 },
        );
      }
      if (url.includes('/swap/v1/swap')) {
        return new Response(JSON.stringify({ swapTransaction, lastValidBlockHeight: 100 }), {
          status: 200,
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
}

describe('JupiterClient latency marks (Latency Optimization Stage 1, 2026-07-14)', () => {
  it('getQuote marks quote_request before the call and quote_received after a successful response', async () => {
    stubJupiterFetch(Keypair.generate().publicKey);
    const client = new JupiterClient({ apiBase: 'https://example.test' });

    latencyTracker.start('t1', 'BUY');
    await client.getQuote(
      { inputMint: SOL_MINT, outputMint: 'MintA', amountLamports: 1_000_000n, slippageBps: 100 },
      { traceId: 't1' },
    );

    latencyTracker.finish('t1', 'success');
    const [trace] = latencyTracker.getCompleted();
    expect(Object.keys(trace!.marks)).toEqual(['quote_request', 'quote_received']);
  });

  it('getQuote never marks quote_received when the request fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('server error', { status: 500 })),
    );
    const client = new JupiterClient({ apiBase: 'https://example.test' });

    latencyTracker.start('t2', 'BUY');
    await expect(
      client.getQuote(
        { inputMint: SOL_MINT, outputMint: 'MintA', amountLamports: 1_000_000n, slippageBps: 100 },
        { traceId: 't2' },
      ),
    ).rejects.toThrow();

    latencyTracker.finish('t2', 'failure');
    const [trace] = latencyTracker.getCompleted();
    expect(Object.keys(trace!.marks)).toEqual(['quote_request']);
  });

  it('prepareSwap marks quote_request/quote_received/tx_build/tx_sign in order, without changing what it returns', async () => {
    const signer = Keypair.generate();
    stubJupiterFetch(signer.publicKey);
    const client = new JupiterClient({ apiBase: 'https://example.test' });
    const connection = {
      simulateTransaction: vi.fn().mockResolvedValue({ value: { err: null } }),
    } as never;

    latencyTracker.start('t3', 'BUY');
    const result = await client.prepareSwap(
      connection,
      signer,
      { inputMint: SOL_MINT, outputMint: 'MintA', amountLamports: 1_000_000n, slippageBps: 100 },
      { traceId: 't3' },
    );
    latencyTracker.finish('t3', 'success');

    expect(result.transaction).toBeInstanceOf(VersionedTransaction);
    expect(result.lastValidBlockHeight).toBe(100);

    const [trace] = latencyTracker.getCompleted();
    expect(Object.keys(trace!.marks)).toEqual([
      'quote_request',
      'quote_received',
      'tx_build',
      'tx_sign',
    ]);
    const values = Object.values(trace!.marks) as number[];
    for (let i = 1; i < values.length; i++) {
      expect(values[i]!).toBeGreaterThanOrEqual(values[i - 1]!);
    }
  });

  it('is a complete no-op on latency when no traceId is passed — behavior for every existing caller is unaffected', async () => {
    stubJupiterFetch(Keypair.generate().publicKey);
    const client = new JupiterClient({ apiBase: 'https://example.test' });

    const quote = await client.getQuote({
      inputMint: SOL_MINT,
      outputMint: 'MintA',
      amountLamports: 1_000_000n,
      slippageBps: 100,
    });

    expect(quote.outAmount).toBe('2000');
    expect(latencyTracker.getCompleted()).toHaveLength(0);
  });
});

describe('JupiterClient.warmConnection (Stage 2 latency optimization, 2026-07-14)', () => {
  it('fires a real quote request to warm the connection', async () => {
    const fetchMock = vi.fn(
      async (_input: string | URL) =>
        new Response(
          JSON.stringify({
            inAmount: '1000000',
            outAmount: '1',
            priceImpactPct: '0',
            routePlan: [],
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = new JupiterClient({ apiBase: 'https://example.test' });

    await client.warmConnection();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]!.toString()).toContain('/swap/v1/quote');
  });

  it('never throws when the warmup request fails — startup must never depend on Jupiter being reachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network unreachable');
      }),
    );
    const client = new JupiterClient({ apiBase: 'https://example.test' });

    await expect(client.warmConnection()).resolves.toBeUndefined();
  });
});
