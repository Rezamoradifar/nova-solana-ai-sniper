import { describe, expect, it } from 'vitest';
import { classifySellFailure } from './sellFailureClassifier.js';

describe('classifySellFailure', () => {
  it('categorizes slippage-exceeded errors as non-retryable', () => {
    const result = classifySellFailure(new Error('Slippage tolerance exceeded'));
    expect(result.category).toBe('slippage');
    expect(result.retryablePreBroadcast).toBe(false);
  });

  it('categorizes "no route found" as route_unavailable, non-retryable', () => {
    const result = classifySellFailure(
      new Error('Jupiter quote failed: 400 could not find any route'),
    );
    expect(result.category).toBe('route_unavailable');
    expect(result.retryablePreBroadcast).toBe(false);
  });

  it('categorizes zero-liquidity pool errors as liquidity, non-retryable', () => {
    const result = classifySellFailure(
      new Error('Computed sell quote is zero — pool has no depth'),
    );
    expect(result.category).toBe('liquidity');
    expect(result.retryablePreBroadcast).toBe(false);
  });

  it('categorizes a blockhash rejection as retryable — it is guaranteed to have never landed', () => {
    const result = classifySellFailure(
      new Error('failed to send transaction: Blockhash not found'),
    );
    expect(result.category).toBe('blockhash_expired');
    expect(result.retryablePreBroadcast).toBe(true);
  });

  it('categorizes a transient network error as rpc_timeout, retryable', () => {
    const result = classifySellFailure(new Error('fetch failed: ETIMEDOUT'));
    expect(result.category).toBe('rpc_timeout');
    expect(result.retryablePreBroadcast).toBe(true);
  });

  it('categorizes a 429 from an RPC provider as rpc_timeout, retryable', () => {
    const result = classifySellFailure(new Error('429 Too Many Requests'));
    expect(result.category).toBe('rpc_timeout');
    expect(result.retryablePreBroadcast).toBe(true);
  });

  it('categorizes a simulation failure as simulation_failed, non-retryable', () => {
    const result = classifySellFailure(
      new Error('Swap simulation failed: {"InstructionError":[0,"Custom"]}'),
    );
    expect(result.category).toBe('simulation_failed');
    expect(result.retryablePreBroadcast).toBe(false);
  });

  it('categorizes an on-chain revert as non-retryable (already broadcast)', () => {
    const result = classifySellFailure(
      new Error('Transaction sig123 landed but reverted on-chain: {"InstructionError":[]}'),
    );
    expect(result.retryablePreBroadcast).toBe(false);
  });

  it('categorizes an ambiguous confirmation timeout as confirmation_timeout, non-retryable', () => {
    const result = classifySellFailure(new Error('Transaction was not confirmed in 60.00 seconds'));
    expect(result.category).toBe('confirmation_timeout');
    expect(result.retryablePreBroadcast).toBe(false);
  });

  it('categorizes a zero-balance wallet as token_account_issue, non-retryable', () => {
    const result = classifySellFailure(
      new Error('wallet holds 0 of this token for a position recorded OPEN'),
    );
    expect(result.category).toBe('token_account_issue');
    expect(result.retryablePreBroadcast).toBe(false);
  });

  it('categorizes an ATA resolution failure as ata_issue, non-retryable', () => {
    const result = classifySellFailure(
      new Error('failed to derive Associated Token Account for mint X'),
    );
    expect(result.category).toBe('ata_issue');
    expect(result.retryablePreBroadcast).toBe(false);
  });

  it('categorizes an active position-close lock as position_lock, non-retryable', () => {
    const result = classifySellFailure(
      new Error(
        'Position pos-1 is already being closed or partially sold by another in-flight operation',
      ),
    );
    expect(result.category).toBe('position_lock');
    expect(result.retryablePreBroadcast).toBe(false);
  });

  it('categorizes a generic Jupiter 5xx as jupiter_failure, retryable', () => {
    const result = classifySellFailure(new Error('Jupiter swap build failed: 502 Bad Gateway'));
    expect(result.category).toBe('jupiter_failure');
    expect(result.retryablePreBroadcast).toBe(true);
  });

  it('falls back to other, non-retryable for anything unrecognized', () => {
    const result = classifySellFailure(new Error('some completely novel failure mode'));
    expect(result.category).toBe('other');
    expect(result.retryablePreBroadcast).toBe(false);
  });

  it('never throws on a non-Error value', () => {
    expect(() => classifySellFailure({ weird: true })).not.toThrow();
    expect(() => classifySellFailure(undefined)).not.toThrow();
    expect(() => classifySellFailure('plain string error')).not.toThrow();
  });
});
