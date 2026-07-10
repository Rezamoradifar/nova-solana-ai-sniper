import { describe, expect, it } from 'vitest';
import { isBuyInstruction, isCreateInstruction, isMigrationInstruction } from './pumpfun.js';

describe('isCreateInstruction', () => {
  it('matches the plain Create instruction', () => {
    expect(isCreateInstruction(['Program log: Instruction: Create'])).toBe(true);
  });

  it('matches the CreateV2 variant', () => {
    expect(isCreateInstruction(['Program log: Instruction: CreateV2'])).toBe(true);
  });

  it('does not match CreateFeeSharingConfig (verified live: zero token balance movement)', () => {
    expect(isCreateInstruction(['Program log: Instruction: CreateFeeSharingConfig'])).toBe(false);
  });
});

describe('isBuyInstruction', () => {
  it('matches Buy, BuyV2, and BuyExactQuoteInV2', () => {
    expect(isBuyInstruction(['Program log: Instruction: Buy'])).toBe(true);
    expect(isBuyInstruction(['Program log: Instruction: BuyV2'])).toBe(true);
    expect(isBuyInstruction(['Program log: Instruction: BuyExactQuoteInV2'])).toBe(true);
  });

  it('does not match Sell', () => {
    expect(isBuyInstruction(['Program log: Instruction: Sell'])).toBe(false);
  });
});

describe('isMigrationInstruction', () => {
  it('matches a plain Withdraw instruction', () => {
    expect(isMigrationInstruction(['Program log: Instruction: Withdraw'])).toBe(true);
  });

  it('does not match MigrateBondingCurveCreator (verified live: unrelated fee-config admin instruction, zero token balance movement)', () => {
    expect(isMigrationInstruction(['Program log: Instruction: MigrateBondingCurveCreator'])).toBe(
      false,
    );
  });

  it('does not match unrelated logs', () => {
    expect(isMigrationInstruction(['Program log: Instruction: Buy'])).toBe(false);
  });
});
