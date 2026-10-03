import { Keypair, PublicKey } from '@solana/web3.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JupiterInstructionClient } from './jupiterInstructions.js';
import type { QuoteResponse } from './jupiter.js';

afterEach(() => vi.unstubAllGlobals());

const PROGRAM = Keypair.generate().publicKey;
const ACCOUNT = Keypair.generate().publicKey;
const LUT = Keypair.generate().publicKey;

function quote(): QuoteResponse {
  return {
    inputMint: Keypair.generate().publicKey.toBase58(),
    outputMint: Keypair.generate().publicKey.toBase58(),
    inAmount: '1000000',
    outAmount: '2000000',
    otherAmountThreshold: '1900000',
    priceImpactPct: '0.0001',
    routePlan: [],
  };
}

function ix(data: Buffer) {
  return {
    programId: PROGRAM.toBase58(),
    accounts: [{ pubkey: ACCOUNT.toBase58(), isSigner: false, isWritable: true }],
    data: data.toString('base64'),
  };
}

describe('JupiterInstructionClient', () => {
  it('decodes ordered composable instructions and lookup table addresses', async () => {
    const fetchMock = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.wrapAndUnwrapSol).toBe(false);
      expect(body.dynamicComputeUnitLimit).toBe(false);
      return new Response(
        JSON.stringify({
          computeBudgetInstructions: [ix(Buffer.from([1]))],
          setupInstructions: [ix(Buffer.from([2]))],
          otherInstructions: [ix(Buffer.from([3]))],
          swapInstruction: ix(Buffer.from([4])),
          cleanupInstruction: ix(Buffer.from([5])),
          addressLookupTableAddresses: [LUT.toBase58()],
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new JupiterInstructionClient('https://example.test');
    const result = await client.buildComposableSwap(quote(), Keypair.generate().publicKey);

    expect(fetchMock.mock.calls[0]?.[0]?.toString()).toBe(
      'https://example.test/swap/v1/swap-instructions',
    );
    expect(result.computeBudgetInstructions.map((instruction) => [...instruction.data])).toEqual([
      [1],
    ]);
    expect(result.instructions.map((instruction) => [...instruction.data])).toEqual([
      [2],
      [3],
      [4],
      [5],
    ]);
    expect(result.instructions.every((instruction) => instruction.programId.equals(PROGRAM))).toBe(
      true,
    );
    expect(result.addressLookupTableAddresses.map((address) => address.toBase58())).toEqual([
      LUT.toBase58(),
    ]);
  });

  it('keeps cleanup optional and rejects malformed lookup tables', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              computeBudgetInstructions: [],
              setupInstructions: [],
              swapInstruction: ix(Buffer.from([9])),
              cleanupInstruction: null,
              addressLookupTableAddresses: ['not-a-public-key'],
            }),
            { status: 200 },
          ),
      ),
    );

    await expect(
      new JupiterInstructionClient('https://example.test').buildComposableSwap(
        quote(),
        Keypair.generate().publicKey,
      ),
    ).rejects.toThrow(/lookup-table/);
  });

  it('rejects malformed instruction data instead of silently decoding it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              computeBudgetInstructions: [],
              setupInstructions: [],
              swapInstruction: { ...ix(Buffer.from([9])), data: '***' },
              cleanupInstruction: null,
              addressLookupTableAddresses: [],
            }),
            { status: 200 },
          ),
      ),
    );

    await expect(
      new JupiterInstructionClient('https://example.test').buildComposableSwap(
        quote(),
        Keypair.generate().publicKey,
      ),
    ).rejects.toThrow(/instruction data/);
  });

  it('rejects invalid quotes before making a network request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const invalid = { ...quote(), inAmount: '-1' };

    await expect(
      new JupiterInstructionClient('https://example.test').buildComposableSwap(
        invalid,
        new PublicKey(Keypair.generate().publicKey),
      ),
    ).rejects.toThrow(/invalid quote/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
