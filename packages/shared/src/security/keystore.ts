import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { generateMnemonic, mnemonicToSeedSync } from 'bip39';
import { derivePath } from 'ed25519-hd-key';
import { decryptSecret, encryptSecret } from './crypto.js';

const SOLANA_DERIVATION_PATH = "m/44'/501'/0'/0'";

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

/**
 * Generates a brand-new wallet from a fresh BIP39 mnemonic (standard Solana
 * derivation path m/44'/501'/0'/0'). The mnemonic is returned once, here, and
 * is never persisted anywhere — the caller must show it to the user
 * immediately (it's the only way to recover the wallet outside of this
 * server) and then let it fall out of scope.
 */
export function generateWallet(encryptionKey: string): {
  publicKey: string;
  encryptedSecret: string;
  mnemonic: string;
} {
  const mnemonic = generateMnemonic(128); // 12 words
  const seed = mnemonicToSeedSync(mnemonic);
  const { key } = derivePath(SOLANA_DERIVATION_PATH, seed.toString('hex'));
  const keypair = Keypair.fromSeed(key);
  return { ...sealKeypair(keypair, encryptionKey), mnemonic };
}

export function importWalletFromSecretKey(secretB58: string, encryptionKey: string) {
  const keypair = Keypair.fromSecretKey(bs58.decode(secretB58));
  return sealKeypair(keypair, encryptionKey);
}
