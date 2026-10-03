import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import type { QuoteResponse } from './jupiter.js';

export interface JupiterInstructionAccount {
  pubkey: string;
  isSigner: boolean;
  isWritable: boolean;
}

export interface JupiterInstructionPayload {
  programId: string;
  accounts: JupiterInstructionAccount[];
  data: string;
}

export interface JupiterSwapInstructionsResponse {
  computeBudgetInstructions: JupiterInstructionPayload[];
  setupInstructions: JupiterInstructionPayload[];
  swapInstruction: JupiterInstructionPayload;
  cleanupInstruction: JupiterInstructionPayload | null;
  otherInstructions?: JupiterInstructionPayload[];
  addressLookupTableAddresses: string[];
}

export interface JupiterComposableSwap {
  /** Compute budget is intentionally separate so the atomic flash-loan builder can de-duplicate it. */
  computeBudgetInstructions: TransactionInstruction[];
  /** Ordered swap body suitable for insertion between Project 0 borrow and repay instructions. */
  instructions: TransactionInstruction[];
  addressLookupTableAddresses: PublicKey[];
}

function decodeBase64Strict(value: unknown): Buffer {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
  ) {
    throw new Error('Jupiter returned malformed instruction data.');
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length === 0 || decoded.toString('base64') !== value) {
    throw new Error('Jupiter returned malformed instruction data.');
  }
  return decoded;
}

function decodeInstruction(raw: unknown): TransactionInstruction {
  const value = raw as Partial<JupiterInstructionPayload> | null;
  if (
    !value ||
    typeof value.programId !== 'string' ||
    !Array.isArray(value.accounts) ||
    typeof value.data !== 'string'
  ) {
    throw new Error('Jupiter returned a malformed swap instruction.');
  }

  let programId: PublicKey;
  try {
    programId = new PublicKey(value.programId);
  } catch {
    throw new Error('Jupiter returned an invalid instruction program id.');
  }

  const keys = value.accounts.map((account) => {
    if (
      !account ||
      typeof account.pubkey !== 'string' ||
      typeof account.isSigner !== 'boolean' ||
      typeof account.isWritable !== 'boolean'
    ) {
      throw new Error('Jupiter returned a malformed instruction account.');
    }
    try {
      return {
        pubkey: new PublicKey(account.pubkey),
        isSigner: account.isSigner,
        isWritable: account.isWritable,
      };
    } catch {
      throw new Error('Jupiter returned an invalid instruction account.');
    }
  });

  return new TransactionInstruction({
    programId,
    keys,
    data: decodeBase64Strict(value.data),
  });
}

function validQuoteIdentity(quote: QuoteResponse): boolean {
  return (
    typeof quote.inputMint === 'string' &&
    quote.inputMint.length > 0 &&
    typeof quote.outputMint === 'string' &&
    quote.outputMint.length > 0 &&
    typeof quote.inAmount === 'string' &&
    /^\d+$/.test(quote.inAmount) &&
    typeof quote.outAmount === 'string' &&
    /^\d+$/.test(quote.outAmount)
  );
}

/**
 * Requests raw Jupiter instructions instead of a pre-built transaction so they
 * can be inserted inside one Project 0 flash-loan transaction.
 */
export class JupiterInstructionClient {
  constructor(private readonly apiBase: string) {}

  async buildComposableSwap(
    quote: QuoteResponse,
    userPublicKey: PublicKey,
    options: { timeoutMs?: number } = {},
  ): Promise<JupiterComposableSwap> {
    if (!validQuoteIdentity(quote)) {
      throw new Error('Refusing to build instructions for an invalid quote.');
    }

    const response = await fetch(`${this.apiBase}/swap/v1/swap-instructions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal:
        options.timeoutMs === undefined ? undefined : AbortSignal.timeout(options.timeoutMs),
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: userPublicKey.toBase58(),
        wrapAndUnwrapSol: false,
        dynamicComputeUnitLimit: false,
      }),
    });
    if (!response.ok) {
      throw new Error(
        `Jupiter swap-instructions failed: ${response.status} ${await response.text()}`,
      );
    }

    const raw = (await response.json()) as Partial<JupiterSwapInstructionsResponse>;
    if (
      !Array.isArray(raw.computeBudgetInstructions) ||
      !Array.isArray(raw.setupInstructions) ||
      !raw.swapInstruction ||
      !Array.isArray(raw.addressLookupTableAddresses) ||
      (raw.cleanupInstruction !== null &&
        raw.cleanupInstruction !== undefined &&
        typeof raw.cleanupInstruction !== 'object') ||
      (raw.otherInstructions !== undefined && !Array.isArray(raw.otherInstructions))
    ) {
      throw new Error('Jupiter returned an incomplete swap-instructions response.');
    }

    const addressLookupTableAddresses = raw.addressLookupTableAddresses.map((address) => {
      try {
        return new PublicKey(address);
      } catch {
        throw new Error('Jupiter returned an invalid lookup-table address.');
      }
    });

    const instructions = [
      ...raw.setupInstructions.map(decodeInstruction),
      ...(raw.otherInstructions ?? []).map(decodeInstruction),
      decodeInstruction(raw.swapInstruction),
      ...(raw.cleanupInstruction ? [decodeInstruction(raw.cleanupInstruction)] : []),
    ];

    return {
      computeBudgetInstructions: raw.computeBudgetInstructions.map(decodeInstruction),
      instructions,
      addressLookupTableAddresses,
    };
  }
}
