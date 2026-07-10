import { describe, expect, it } from 'vitest';
import { createWalletBackup, restoreWalletBackup, walletBackupSchema } from './backup.js';

const SECRET = '5Kb8kLf9zgWQnogidDA76MzPL6TsZZY36hWXMssSzNydYXYB9KF';
const PUBLIC_KEY = 'FAKEPUBKEY11111111111111111111111111111111';
const PASSWORD = 'correct horse battery staple';

describe('createWalletBackup / restoreWalletBackup', () => {
  it('round-trips the secret key with the correct password', () => {
    const backup = createWalletBackup(SECRET, PUBLIC_KEY, PASSWORD);
    expect(restoreWalletBackup(backup, PASSWORD)).toBe(SECRET);
  });

  it('produces a backup matching the public wire schema', () => {
    const backup = createWalletBackup(SECRET, PUBLIC_KEY, PASSWORD);
    expect(walletBackupSchema.safeParse(backup).success).toBe(true);
    expect(backup.publicKey).toBe(PUBLIC_KEY);
  });

  it('never includes the plaintext secret anywhere in the backup', () => {
    const backup = createWalletBackup(SECRET, PUBLIC_KEY, PASSWORD);
    expect(JSON.stringify(backup)).not.toContain(SECRET);
  });

  it('rejects the wrong password', () => {
    const backup = createWalletBackup(SECRET, PUBLIC_KEY, PASSWORD);
    expect(() => restoreWalletBackup(backup, 'wrong password')).toThrow();
  });

  it('rejects a tampered ciphertext', () => {
    const backup = createWalletBackup(SECRET, PUBLIC_KEY, PASSWORD);
    const tampered = { ...backup, ciphertext: backup.ciphertext.slice(0, -4) + 'abcd' };
    expect(() => restoreWalletBackup(tampered, PASSWORD)).toThrow();
  });

  it('rejects a tampered auth tag', () => {
    const backup = createWalletBackup(SECRET, PUBLIC_KEY, PASSWORD);
    const tampered = { ...backup, authTag: backup.authTag.slice(0, -4) + 'abcd' };
    expect(() => restoreWalletBackup(tampered, PASSWORD)).toThrow();
  });

  it('produces different ciphertext for the same secret on every call (random salt/IV)', () => {
    const a = createWalletBackup(SECRET, PUBLIC_KEY, PASSWORD);
    const b = createWalletBackup(SECRET, PUBLIC_KEY, PASSWORD);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.salt).not.toBe(b.salt);
    expect(a.iv).not.toBe(b.iv);
  });
});
