import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { decryptSecret, encryptSecret } from './crypto.js';

/**
 * In-memory-only wrapper: a decrypted Keypair should never be persisted,
 * logged, or serialized. Callers must use it immediately and let it fall
 * out of scope (no caching of plaintext keys).
 */
export function sealKeypair(
  keypair: Keypair,
  encryptionKey: string,
): {
  publicKey: string;
  encryptedSecret: string;
} {
  const secretB58 = bs58.encode(keypair.secretKey);
  return {
    publicKey: keypair.publicKey.toBase58(),
    encryptedSecret: encryptSecret(secretB58, encryptionKey),
  };
}

export function unsealKeypair(encryptedSecret: string, encryptionKey: string): Keypair {
  const secretB58 = decryptSecret(encryptedSecret, encryptionKey);
  return Keypair.fromSecretKey(bs58.decode(secretB58));
}

export function generateWallet(encryptionKey: string) {
  const keypair = Keypair.generate();
  return sealKeypair(keypair, encryptionKey);
}

export function importWalletFromSecretKey(secretB58: string, encryptionKey: string) {
  const keypair = Keypair.fromSecretKey(bs58.decode(secretB58));
  return sealKeypair(keypair, encryptionKey);
}
