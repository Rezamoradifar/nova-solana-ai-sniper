import { describe, expect, it } from 'vitest';
import { validateMnemonic } from 'bip39';
import bs58 from 'bs58';
import { generateWallet, unsealKeypair, importWalletFromSecretKey } from './keystore.js';

const ENCRYPTION_KEY = 'a'.repeat(32);

describe('generateWallet', () => {
  it('returns a valid 12-word BIP39 mnemonic', () => {
    const wallet = generateWallet(ENCRYPTION_KEY);
    expect(wallet.mnemonic.split(' ')).toHaveLength(12);
    expect(validateMnemonic(wallet.mnemonic)).toBe(true);
  });

  it('the encrypted secret decrypts back to a keypair matching the returned public key', () => {
    const wallet = generateWallet(ENCRYPTION_KEY);
    const keypair = unsealKeypair(wallet.encryptedSecret, ENCRYPTION_KEY);
    expect(keypair.publicKey.toBase58()).toBe(wallet.publicKey);
  });

  it('generates a different wallet every time', () => {
    const a = generateWallet(ENCRYPTION_KEY);
    const b = generateWallet(ENCRYPTION_KEY);
    expect(a.mnemonic).not.toBe(b.mnemonic);
    expect(a.publicKey).not.toBe(b.publicKey);
  });

  it('cannot be decrypted with the wrong encryption key', () => {
    const wallet = generateWallet(ENCRYPTION_KEY);
    expect(() => unsealKeypair(wallet.encryptedSecret, 'b'.repeat(32))).toThrow();
  });
});

describe('importWalletFromSecretKey', () => {
  it('round-trips a raw secret key through seal/unseal', () => {
    const generated = generateWallet(ENCRYPTION_KEY);
    const keypair = unsealKeypair(generated.encryptedSecret, ENCRYPTION_KEY);
    const imported = importWalletFromSecretKey(bs58.encode(keypair.secretKey), ENCRYPTION_KEY);
    expect(imported.publicKey).toBe(generated.publicKey);
  });

  it('rejects garbage input', () => {
    expect(() => importWalletFromSecretKey('not-valid-base58!!', ENCRYPTION_KEY)).toThrow();
  });
});
