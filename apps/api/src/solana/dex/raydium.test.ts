import { PublicKey } from '@solana/web3.js';
import { describe, expect, it, vi } from 'vitest';
import {
  calculateRaydiumCpmmLiquidityUsd,
  decodeRaydiumCpmmPool,
  isRaydiumCpmmPoolCreation,
  RaydiumCpmmMonitor,
} from './raydium.js';

// Real pool captured live 2026-07-10: 7ZFLTdJCmL8PQozEmfPcq8dxsjR4W7LLkbK8hqSGZnQ1
// (SOL / Cqh2KLM8n3odYFJN5jkb7noD7BHj4GwHCCU3Q8Gas6Hy "SUMMER"). Decoded vault
// balances (95.05 SOL, 13328.8 token) closely matched DexScreener's independently
// reported reserves for the same pair (94.96 SOL, 13341 token).
const REAL_POOL = {
  address: '7ZFLTdJCmL8PQozEmfPcq8dxsjR4W7LLkbK8hqSGZnQ1',
  ammConfig: 'BgxH5ifebqHDuiADWKhLjXGP5hWZeZLoCdmeWJLkRqLP',
  poolCreator: '7PSShKjYwCsNuBUbtgBxhQ1UqKsCbDs6q4vcvph8ZJ2D',
  token0Vault: '8cReyGVxAHPCaY5geoPWtbBuxFWze5YvinGZbJJFWNzR',
  token1Vault: 'Dk8FBieG4BstEs1YifLKBYLRgeCyXvfETZwrjq1ZsWCU',
  lpMint: '9tCYdkxohd6WVke9hcpJ8dAqyYCAdqK39mXMxEdN2TQq',
  token0Mint: 'So11111111111111111111111111111111111111112',
  token1Mint: 'Cqh2KLM8n3odYFJN5jkb7noD7BHj4GwHCCU3Q8Gas6Hy',
  token0Program: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  token1Program: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  observationKey: 'BqjZ89yLjmAUQoqEyXFZfMKe7hPaMbmsDFf7PnyXpikD',
  status: 0,
  lpSupply: 35142566781n,
};

function buildRealPoolAccountData(): Buffer {
  const buf = Buffer.alloc(341);
  new PublicKey(REAL_POOL.ammConfig).toBuffer().copy(buf, 8);
  new PublicKey(REAL_POOL.poolCreator).toBuffer().copy(buf, 40);
  new PublicKey(REAL_POOL.token0Vault).toBuffer().copy(buf, 72);
  new PublicKey(REAL_POOL.token1Vault).toBuffer().copy(buf, 104);
  new PublicKey(REAL_POOL.lpMint).toBuffer().copy(buf, 136);
  new PublicKey(REAL_POOL.token0Mint).toBuffer().copy(buf, 168);
  new PublicKey(REAL_POOL.token1Mint).toBuffer().copy(buf, 200);
  new PublicKey(REAL_POOL.token0Program).toBuffer().copy(buf, 232);
  new PublicKey(REAL_POOL.token1Program).toBuffer().copy(buf, 264);
  new PublicKey(REAL_POOL.observationKey).toBuffer().copy(buf, 296);
  buf.writeUInt8(253, 328); // authBump
  buf.writeUInt8(REAL_POOL.status, 329);
  buf.writeUInt8(9, 330); // lpMintDecimals
  buf.writeUInt8(9, 331); // mint0Decimals
  buf.writeUInt8(6, 332); // mint1Decimals
  buf.writeBigUInt64LE(REAL_POOL.lpSupply, 333);
  return buf;
}

describe('decodeRaydiumCpmmPool', () => {
  it('decodes a real live CPMM pool account byte-for-byte correctly', () => {
    const state = decodeRaydiumCpmmPool(REAL_POOL.address, buildRealPoolAccountData());
    expect(state.token0Mint).toBe(REAL_POOL.token0Mint);
    expect(state.token1Mint).toBe(REAL_POOL.token1Mint);
    expect(state.token0Vault).toBe(REAL_POOL.token0Vault);
    expect(state.token1Vault).toBe(REAL_POOL.token1Vault);
    expect(state.status).toBe(0);
    expect(state.lpSupply).toBe(REAL_POOL.lpSupply);
  });

  it('throws on a too-short buffer instead of silently misreading it', () => {
    expect(() => decodeRaydiumCpmmPool(REAL_POOL.address, Buffer.alloc(100))).toThrow();
  });
});

describe('calculateRaydiumCpmmLiquidityUsd', () => {
  it('resolves the SOL side correctly when it is token_0 and matches DexScreener within trade-drift range', () => {
    // 95.05 SOL * ~77.91 * 2 ~= $14,808, DexScreener independently reported $14,760.76.
    const liquidityUsd = calculateRaydiumCpmmLiquidityUsd(
      REAL_POOL.token0Mint,
      REAL_POOL.token1Mint,
      95.051236729,
      13328.836702,
      77.91,
    );
    expect(liquidityUsd).toBeCloseTo(14808, -2);
  });

  it('resolves the SOL side correctly when it is token_1 instead of token_0', () => {
    const liquidityUsd = calculateRaydiumCpmmLiquidityUsd(
      'SomeProjectMint111111111111111111111111111',
      'So11111111111111111111111111111111111111112',
      13328.836702,
      95.051236729,
      77.91,
    );
    expect(liquidityUsd).toBeCloseTo(14808, -2);
  });

  it('returns 0 when neither side is SOL rather than guessing', () => {
    expect(
      calculateRaydiumCpmmLiquidityUsd(
        'MintA1111111111111111111111111111111111111',
        'MintB1111111111111111111111111111111111111',
        1000,
        1000,
        77.91,
      ),
    ).toBe(0);
  });

  it('returns 0 when the SOL price is unavailable', () => {
    expect(
      calculateRaydiumCpmmLiquidityUsd(
        REAL_POOL.token0Mint,
        REAL_POOL.token1Mint,
        95,
        13328,
        undefined,
      ),
    ).toBe(0);
  });
});

describe('isRaydiumCpmmPoolCreation', () => {
  it('matches the Initialize instruction names', () => {
    expect(isRaydiumCpmmPoolCreation(['Program log: Instruction: Initialize'])).toBe(true);
    expect(isRaydiumCpmmPoolCreation(['Program log: Instruction: InitializeWithPermission'])).toBe(
      true,
    );
  });

  it('does not match swap/deposit/withdraw instructions', () => {
    expect(isRaydiumCpmmPoolCreation(['Program log: Instruction: SwapBaseInput'])).toBe(false);
    expect(isRaydiumCpmmPoolCreation(['Program log: Instruction: Deposit'])).toBe(false);
    expect(isRaydiumCpmmPoolCreation(['Program log: Instruction: Withdraw'])).toBe(false);
  });
});

describe('RaydiumCpmmMonitor', () => {
  function fakeConnection() {
    let handler: ((logInfo: unknown, ctx: { slot: number }) => void) | undefined;
    return {
      onLogs: vi.fn((_programId: unknown, cb: typeof handler) => {
        handler = cb;
        return 1;
      }),
      removeOnLogsListener: vi.fn(),
      emit: (logInfo: unknown, ctx: { slot: number } = { slot: 1 }) => handler!(logInfo, ctx),
    };
  }

  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

  it('calls onRawActivity on every raw log delivery, including errored and non-pool-creation ones (2026-07-15 Helius credit audit)', () => {
    const connection = fakeConnection();
    const monitor = new RaydiumCpmmMonitor(connection as never, logger);
    const onEvent = vi.fn();
    const onRawActivity = vi.fn();
    monitor.start(onEvent, onRawActivity);

    connection.emit({ err: { InstructionError: [] }, logs: [], signature: 'sig-err' });
    connection.emit({
      err: null,
      logs: ['Program log: Instruction: SwapBaseInput'],
      signature: 'sig-swap',
    });
    connection.emit({
      err: null,
      logs: ['Program log: Instruction: Initialize'],
      signature: 'sig-init',
    });

    expect(onRawActivity).toHaveBeenCalledTimes(3);
    // onEvent only fires on the genuine pool-creation log — unchanged behavior.
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ signature: 'sig-init' }));
  });

  it('works exactly as before when onRawActivity is omitted (backward compatible)', () => {
    const connection = fakeConnection();
    const monitor = new RaydiumCpmmMonitor(connection as never, logger);
    const onEvent = vi.fn();
    monitor.start(onEvent);

    expect(() =>
      connection.emit({
        err: null,
        logs: ['Program log: Instruction: Initialize'],
        signature: 'sig-init',
      }),
    ).not.toThrow();
    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  it('registers only one onLogs subscription per start() call (no duplicate WS registration)', () => {
    const connection = fakeConnection();
    const monitor = new RaydiumCpmmMonitor(connection as never, logger);
    monitor.start(vi.fn(), vi.fn());
    expect(connection.onLogs).toHaveBeenCalledTimes(1);
  });
});
