import { describe, expect, it } from 'vitest';
import {
  evaluateEmergencyExit,
  LIQUIDITY_REMOVED_THRESHOLD_USD,
  CRITICAL_RUG_SCORE_THRESHOLD,
  DEV_WALLET_DUMP_THRESHOLD_PERCENT,
  type EmergencyExitSignals,
} from './emergencyExit.js';

/** A signals object that passes every check cleanly — individual tests
 * override exactly the one field under test. */
function safeSignals(overrides: Partial<EmergencyExitSignals> = {}): EmergencyExitSignals {
  return {
    liquidityUsd: 50_000,
    mintAuthorityRevoked: true,
    freezeAuthorityRevoked: true,
    canSell: true,
    ruleScore: 90,
    devWalletAmountRawAtEntry: 1_000_000n,
    devWalletCurrentAmountRaw: 1_000_000n,
    ...overrides,
  };
}

describe('evaluateEmergencyExit', () => {
  it('does not trigger when every signal is clean', () => {
    const decision = evaluateEmergencyExit(safeSignals());
    expect(decision).toEqual({ shouldExit: false });
  });

  it('triggers liquidity_removed when liquidity drops below the threshold', () => {
    const decision = evaluateEmergencyExit(
      safeSignals({ liquidityUsd: LIQUIDITY_REMOVED_THRESHOLD_USD - 1 }),
    );
    expect(decision.shouldExit).toBe(true);
    expect(decision.reason).toBe('liquidity_removed');
    expect(decision.detail).toContain('liquidityUsd');
  });

  it('does not trigger liquidity_removed exactly at the threshold (boundary is exclusive below)', () => {
    const decision = evaluateEmergencyExit(
      safeSignals({ liquidityUsd: LIQUIDITY_REMOVED_THRESHOLD_USD }),
    );
    expect(decision.shouldExit).toBe(false);
  });

  it('triggers trading_disabled when the Jupiter sell-route probe finds no route', () => {
    const decision = evaluateEmergencyExit(safeSignals({ canSell: false }));
    expect(decision.shouldExit).toBe(true);
    expect(decision.reason).toBe('trading_disabled');
  });

  it('triggers mint_reenabled when mint authority is no longer revoked', () => {
    const decision = evaluateEmergencyExit(safeSignals({ mintAuthorityRevoked: false }));
    expect(decision.shouldExit).toBe(true);
    expect(decision.reason).toBe('mint_reenabled');
  });

  it('triggers freeze_reenabled when freeze authority is no longer revoked', () => {
    const decision = evaluateEmergencyExit(safeSignals({ freezeAuthorityRevoked: false }));
    expect(decision.shouldExit).toBe(true);
    expect(decision.reason).toBe('freeze_reenabled');
  });

  it('triggers critical_rug_score when the rule score drops below the threshold', () => {
    const decision = evaluateEmergencyExit(
      safeSignals({ ruleScore: CRITICAL_RUG_SCORE_THRESHOLD - 1 }),
    );
    expect(decision.shouldExit).toBe(true);
    expect(decision.reason).toBe('critical_rug_score');
  });

  it('does not trigger critical_rug_score exactly at the threshold', () => {
    const decision = evaluateEmergencyExit(
      safeSignals({ ruleScore: CRITICAL_RUG_SCORE_THRESHOLD }),
    );
    expect(decision.shouldExit).toBe(false);
  });

  it('triggers dev_wallet_dump when the tracked wallet has sold >= the threshold percent', () => {
    const atEntry = 1_000_000n;
    const current = (atEntry * BigInt(100 - DEV_WALLET_DUMP_THRESHOLD_PERCENT)) / 100n;
    const decision = evaluateEmergencyExit(
      safeSignals({ devWalletAmountRawAtEntry: atEntry, devWalletCurrentAmountRaw: current }),
    );
    expect(decision.shouldExit).toBe(true);
    expect(decision.reason).toBe('dev_wallet_dump');
    expect(decision.detail).toContain('50.0%');
  });

  it('treats a fully-drained-to-zero tracked wallet as a dump', () => {
    const decision = evaluateEmergencyExit(
      safeSignals({ devWalletAmountRawAtEntry: 1_000_000n, devWalletCurrentAmountRaw: 0n }),
    );
    expect(decision.shouldExit).toBe(true);
    expect(decision.reason).toBe('dev_wallet_dump');
  });

  it('does not trigger dev_wallet_dump for a small, ordinary sell below the threshold', () => {
    const decision = evaluateEmergencyExit(
      safeSignals({ devWalletAmountRawAtEntry: 1_000_000n, devWalletCurrentAmountRaw: 900_000n }),
    );
    expect(decision.shouldExit).toBe(false);
  });

  it('never trips dev_wallet_dump on a balance increase (buying more is not a dump)', () => {
    const decision = evaluateEmergencyExit(
      safeSignals({ devWalletAmountRawAtEntry: 1_000_000n, devWalletCurrentAmountRaw: 2_000_000n }),
    );
    expect(decision.shouldExit).toBe(false);
  });

  it('skips the dev_wallet_dump check entirely when the entry balance is unknown (undefined)', () => {
    const decision = evaluateEmergencyExit(
      safeSignals({ devWalletAmountRawAtEntry: undefined, devWalletCurrentAmountRaw: 0n }),
    );
    expect(decision.shouldExit).toBe(false);
  });

  it('skips the dev_wallet_dump check entirely when the current balance is unknown (undefined)', () => {
    const decision = evaluateEmergencyExit(
      safeSignals({ devWalletAmountRawAtEntry: 1_000_000n, devWalletCurrentAmountRaw: undefined }),
    );
    expect(decision.shouldExit).toBe(false);
  });

  it('never divides by zero when the entry balance itself was recorded as 0', () => {
    const decision = evaluateEmergencyExit(
      safeSignals({ devWalletAmountRawAtEntry: 0n, devWalletCurrentAmountRaw: 0n }),
    );
    expect(decision.shouldExit).toBe(false);
  });

  it('checks conditions in priority order — liquidity_removed wins even when other signals also fail', () => {
    const decision = evaluateEmergencyExit(
      safeSignals({
        liquidityUsd: 0,
        canSell: false,
        mintAuthorityRevoked: false,
        freezeAuthorityRevoked: false,
        ruleScore: 0,
      }),
    );
    expect(decision.reason).toBe('liquidity_removed');
  });

  it('checks mint_reenabled before freeze_reenabled and critical_rug_score', () => {
    const decision = evaluateEmergencyExit(
      safeSignals({ mintAuthorityRevoked: false, freezeAuthorityRevoked: false, ruleScore: 0 }),
    );
    expect(decision.reason).toBe('mint_reenabled');
  });
});
