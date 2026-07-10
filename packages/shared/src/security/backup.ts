import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from 'node:crypto';
import { z } from 'zod';

const BACKUP_VERSION = 1;
const BACKUP_KIND = 'nova-wallet-backup';
const ALGO = 'aes-256-gcm';
const IV_LENGTH = 12;
const SALT_LENGTH = 16;

export const walletBackupSchema = z.object({
  version: z.literal(BACKUP_VERSION),
  kind: z.literal(BACKUP_KIND),
  publicKey: z.string().min(32).max(44),
  createdAt: z.string(),
  salt: z.string(),
  iv: z.string(),
  authTag: z.string(),
  ciphertext: z.string(),
});

export type WalletBackup = z.infer<typeof walletBackupSchema>;

function deriveBackupKey(password: string, salt: Buffer): Buffer {
  return scryptSync(password, salt, 32);
}

/**
 * Encrypts a wallet's secret key with a user-chosen password (AES-256-GCM,
 * random salt/IV per backup) into a portable, exportable file. This is
 * independent of the server's own at-rest ENCRYPTION_KEY — anyone who gets
 * the file still needs the password to recover anything from it.
 */
export function createWalletBackup(
  secretKeyBase58: string,
  publicKey: string,
  password: string,
): WalletBackup {
  const salt = randomBytes(SALT_LENGTH);
  const iv = randomBytes(IV_LENGTH);
  const key = deriveBackupKey(password, salt);

  const cipher = createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(secretKeyBase58, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    version: BACKUP_VERSION,
    kind: BACKUP_KIND,
    publicKey,
    createdAt: new Date().toISOString(),
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

/**
 * Decrypts a backup produced by `createWalletBackup`. AES-GCM's auth tag
 * makes a wrong password or a corrupted/tampered file throw here rather than
 * silently returning garbage.
 */
export function restoreWalletBackup(backup: WalletBackup, password: string): string {
  const salt = Buffer.from(backup.salt, 'base64');
  const iv = Buffer.from(backup.iv, 'base64');
  const authTag = Buffer.from(backup.authTag, 'base64');
  const ciphertext = Buffer.from(backup.ciphertext, 'base64');
  const key = deriveBackupKey(password, salt);

  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}
