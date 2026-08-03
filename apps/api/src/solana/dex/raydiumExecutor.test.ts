import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import { describe, expect, it, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { RaydiumExecutor } from './raydiumExecutor.js';

const WSOL_MINT = 'So11111111111111111111111111111111111111112';

// Same real, live-captured pool as raydium.test.ts's REAL_POOL fixture
// (7ZFLTdJCmL8PQozEmfPcq8dxsjR4W7LLkbK8hqSGZnQ1) — token0 is SOL, token1 is
// the traded memecoin, both classic-Token-program mints.
const POOL = {
  address: '7ZFLTdJCmL8PQozEmfPcq8dxsjR4W7LLkbK8hqSGZnQ1',
  ammConfig: 'BgxH5ifebqHDuiADWKhLjXGP5hWZeZLoCdmeWJLkRqLP',
  poolCreator: '7PSShKjYwCsNuBUbtgBxhQ1UqKsCbDs6q4vcvph8ZJ2D',
  token0Vault: '8cReyGVxAHPCaY5geoPWtbBuxFWze5YvinGZbJJFWNzR',
  token1Vault: 'Dk8FBieG4BstEs1YifLKBYLRgeCyXvfETZwrjq1ZsWCU',
  lpMint: '9tCYdkxohd6WVke9hcpJ8dAqyYCAdqK39mXMxEdN2TQq',
  token0Mint: WSOL_MINT,
  token1Mint: 'Cqh2KLM8n3odYFJN5jkb7noD7BHj4GwHCCU3Q8Gas6Hy',
  token0Program: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  token1Program: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  observationKey: 'BqjZ89yLjmAUQoqEyXFZfMKe7hPaMbmsDFf7PnyXpikD',
};
const RAYDIUM_CPMM_PROGRAM_ID = new PublicKey('CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C');

function buildPoolAccountData(): Buffer {
  const buf = Buffer.alloc(341);
  new PublicKey(POOL.ammConfig).toBuffer().copy(buf, 8);
  new PublicKey(POOL.poolCreator).toBuffer().copy(buf, 40);
  new PublicKey(POOL.token0Vault).toBuffer().copy(buf, 72);
  new PublicKey(POOL.token1Vault).toBuffer().copy(buf, 104);
  new PublicKey(POOL.lpMint).toBuffer().copy(buf, 136);
  new PublicKey(POOL.token0Mint).toBuffer().copy(buf, 168);
  new PublicKey(POOL.token1Mint).toBuffer().copy(buf, 200);
  new PublicKey(POOL.token0Program).toBuffer().copy(buf, 232);
  new PublicKey(POOL.token1Program).toBuffer().copy(buf, 264);
  new PublicKey(POOL.observationKey).toBuffer().copy(buf, 296);
  buf.writeUInt8(253, 328); // authBump
  buf.writeUInt8(0, 329); // status: swap enabled
  buf.writeUInt8(9, 330);
  buf.writeUInt8(9, 331);
  buf.writeUInt8(6, 332);
  buf.writeBigUInt64LE(35_142_566_781n, 333);
  return buf;
}

function fakeConnection(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    getAccountInfo: vi.fn().mockResolvedValue({
      owner: RAYDIUM_CPMM_PROGRAM_ID,
      data: buildPoolAccountData(),
    }),
    getTokenAccountBalance: vi.fn().mockResolvedValue({ value: { amount: '1000000000' } }),
    getLatestBlockhash: vi.fn().mockResolvedValue({ blockhash: WSOL_MINT }),
    ...overrides,
  } as never;
}

describe('RaydiumExecutor.buildSwap', () => {
  const signer = Keypair.generate();

  it('rejects when poolAddress is not supplied', async () => {
    const executor = new RaydiumExecutor();
    await expect(
      executor.buildSwap({
        connection: fakeConnection(),
        signer,
        inputMint: WSOL_MINT,
        outputMint: POOL.token1Mint,
        amountLamports: 1_000_000n,
        slippageBps: 500,
      }),
    ).rejects.toThrow(/requires a known poolAddress/);
  });

  it('rejects when the pool account is not owned by the Raydium CPMM program', async () => {
    const executor = new RaydiumExecutor();
    await expect(
      executor.buildSwap({
        connection: fakeConnection({
          getAccountInfo: vi
            .fn()
            .mockResolvedValue({ owner: Keypair.generate().publicKey, data: Buffer.alloc(341) }),
        }),
        signer,
        inputMint: WSOL_MINT,
        outputMint: POOL.token1Mint,
        amountLamports: 1_000_000n,
        slippageBps: 500,
        poolAddress: POOL.address,
      }),
    ).rejects.toThrow(/not found or not owned/);
  });

  it('rejects a mint pair that does not match the pool token_0/token_1', async () => {
    const executor = new RaydiumExecutor();
    await expect(
      executor.buildSwap({
        connection: fakeConnection(),
        signer,
        inputMint: WSOL_MINT,
        outputMint: 'SomeOtherMint1111111111111111111111111111',
        amountLamports: 1_000_000n,
        slippageBps: 500,
        poolAddress: POOL.address,
      }),
    ).rejects.toThrow(/does not match pool/);
  });

  it('builds a real, signed, simulatable buy transaction with the correct discriminator and account order', async () => {
    const executor = new RaydiumExecutor();
    const tx = await executor.buildSwap({
      connection: fakeConnection(),
      signer,
      inputMint: WSOL_MINT,
      outputMint: POOL.token1Mint,
      amountLamports: 1_000_000n,
      slippageBps: 500,
      poolAddress: POOL.address,
    });

    expect(tx).toBeInstanceOf(VersionedTransaction);
    expect(tx.signatures.length).toBeGreaterThan(0);

    const message = tx.message;
    const swapIxIndex = message.compiledInstructions.findIndex((ix) =>
      message.staticAccountKeys[ix.programIdIndex]!.equals(RAYDIUM_CPMM_PROGRAM_ID),
    );
    expect(swapIxIndex).toBeGreaterThanOrEqual(0);
    const swapIx = message.compiledInstructions[swapIxIndex]!;

    // Discriminator: sha256("global:swap_base_input")[0:8], computed directly
    // (not recalled from memory) — see raydiumExecutor.ts's header.
    const data = Buffer.from(swapIx.data);
    expect([...data.subarray(0, 8)]).toEqual([143, 190, 90, 218, 196, 30, 51, 222]);
    // amount_in (u64 LE) at bytes 8-16 — the exact amount requested.
    expect(data.readBigUInt64LE(8)).toBe(1_000_000n);

    const keys = swapIx.accountKeyIndexes.map((i) => message.staticAccountKeys[i]!);
    // Account order per swap_base_input.rs's Swap Accounts struct: payer,
    // authority, amm_config, pool_state, input_token_account,
    // output_token_account, input_vault, output_vault, input_token_program,
    // output_token_program, input_token_mint, output_token_mint,
    // observation_state — 13 accounts.
    expect(keys).toHaveLength(13);
    expect(keys[0]!.equals(signer.publicKey)).toBe(true); // payer
    expect(keys[2]!.toBase58()).toBe(POOL.ammConfig); // amm_config
    expect(keys[3]!.toBase58()).toBe(POOL.address); // pool_state
    expect(keys[6]!.toBase58()).toBe(POOL.token0Vault); // input_vault (buy: input=token0=SOL)
    expect(keys[7]!.toBase58()).toBe(POOL.token1Vault); // output_vault
    expect(keys[10]!.toBase58()).toBe(WSOL_MINT); // input_token_mint
    expect(keys[11]!.toBase58()).toBe(POOL.token1Mint); // output_token_mint
    expect(keys[12]!.toBase58()).toBe(POOL.observationKey); // observation_state

    // Buy path: WSOL wrap instructions (idempotent ATA + transfer + syncNative)
    // must precede the swap instruction.
    expect(swapIxIndex).toBeGreaterThan(0);
  });

  it('builds a sell transaction with input/output reversed relative to the buy case', async () => {
    const executor = new RaydiumExecutor();
    const tx = await executor.buildSwap({
      connection: fakeConnection(),
      signer,
      inputMint: POOL.token1Mint,
      outputMint: WSOL_MINT,
      amountLamports: 500_000n,
      slippageBps: 500,
      poolAddress: POOL.address,
    });

    const message = tx.message;
    const swapIx = message.compiledInstructions.find((ix) =>
      message.staticAccountKeys[ix.programIdIndex]!.equals(RAYDIUM_CPMM_PROGRAM_ID),
    )!;
    const keys = swapIx.accountKeyIndexes.map((i) => message.staticAccountKeys[i]!);

    expect(keys[6]!.toBase58()).toBe(POOL.token1Vault); // input_vault (sell: input=token1)
    expect(keys[7]!.toBase58()).toBe(POOL.token0Vault); // output_vault (=SOL)
    expect(keys[10]!.toBase58()).toBe(POOL.token1Mint);
    expect(keys[11]!.toBase58()).toBe(WSOL_MINT);

    // Sell path: a close-account (unwrap) instruction must follow the swap.
    const swapIndex = message.compiledInstructions.indexOf(swapIx);
    expect(swapIndex).toBeLessThan(message.compiledInstructions.length - 1);
  });

  it('throws instead of sending when the computed quote is zero (no pool depth)', async () => {
    const executor = new RaydiumExecutor();
    await expect(
      executor.buildSwap({
        connection: fakeConnection({
          getTokenAccountBalance: vi.fn().mockResolvedValue({ value: { amount: '0' } }),
        }),
        signer,
        inputMint: WSOL_MINT,
        outputMint: POOL.token1Mint,
        amountLamports: 1_000_000n,
        slippageBps: 500,
        poolAddress: POOL.address,
      }),
    ).rejects.toThrow(/quote is zero/);
  });
});
