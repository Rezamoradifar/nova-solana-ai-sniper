import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_LENGTH = 12;

/**
 * Derives a 32-byte key from ENCRYPTION_KEY via scrypt so the raw env secret
 * is never used directly as an AES key. Salt is fixed per-deployment (env-derived)
 * because we need deterministic derivation without storing a separate salt per record.
 */
function deriveKey(encryptionKey: string): Buffer {
  return scryptSync(encryptionKey, 'nova-sniper-static-salt-v1', 32);
}

/**
 * Encrypts a secret (private key / seed phrase) for at-rest storage.
 * Output format: base64(iv).base64(authTag).base64(ciphertext)
 * Never log or return the plaintext input past this boundary.
 */
export function encryptSecret(plaintext: string, encryptionKey: string): string {
  const key = deriveKey(encryptionKey);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString('base64'), authTag.toString('base64'), ciphertext.toString('base64')].join(
    '.',
  );
}

export function decryptSecret(payload: string, encryptionKey: string): string {
  const [ivB64, tagB64, dataB64] = payload.split('.');
  if (!ivB64 || !tagB64 || !dataB64) {
    throw new Error('Malformed encrypted payload');
  }
  const key = deriveKey(encryptionKey);
  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(tagB64, 'base64');
  const ciphertext = Buffer.from(dataB64, 'base64');
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}
