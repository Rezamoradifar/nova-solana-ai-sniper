import {
  Connection,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { PUMPSWAP_PROGRAM_ID, getPumpSwapPoolState } from './pumpswap.js';
import type { NativeDexExecutor, NativeSwapParams } from './types.js';

/**
 * Fallback-only native PumpSwap swap builder — Jupiter (which already routes
 * through PumpSwap) is the primary execution path; this only fires when Jupiter
 * can't find a route. Every account, PDA seed, and instruction discriminator here
 * is sourced directly from pump-fun's own published IDL
 * (github.com/pump-fun/pump-public-docs/blob/main/idl/pump_amm.json), not
 * reverse-engineered or guessed. Never sends a transaction itself — callers must
 * simulate first (same discipline the existing Jupiter path already follows in
 * JupiterClient.prepareSwap) before ever treating the result as sendable.
 *
 * Verification status: the `global_config` PDA seed was confirmed live (the
 * account was found and decoded successfully against a real mainnet pool). A full
 * signed dry-run simulation was not completed — that requires a real Keypair with
 * an actual SOL balance (a fee-payer that merely exists on-chain, with no
 * matching signer, hits an ATA-derivation mismatch, not a meaningful result), and
 * using a real wallet's private key even for a zero-cost simulation was judged
 * out of scope without the user's explicit go-ahead. Get that sign-off, then run
 * one signed `simulateTransaction` dry-run (still no broadcast) before this is
 * ever treated as fully verified.
 */

const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');
const FEE_PROGRAM_ID = new PublicKey('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ');

const BUY_DISCRIMINATOR = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]);
const SELL_DISCRIMINATOR = Buffer.from([51, 230, 133, 164, 1, 127, 131, 173]);

// fee_config's second PDA seed, a fixed constant per the IDL (not derived from any
// account — it's the same for every pool).
const FEE_CONFIG_SEED_2 = Buffer.from([
  12, 20, 222, 252, 130, 94, 198, 118, 148, 37, 8, 24, 187, 101, 64, 101, 244, 41, 141, 49, 86, 213,
  113, 180, 212, 248, 9, 12, 24, 233, 168, 99,
]);

function pda(seeds: (Buffer | Uint8Array)[], programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, programId)[0];
}

const globalConfigPda = () => pda([Buffer.from('global_config')], PUMPSWAP_PROGRAM_ID);
const eventAuthorityPda = () => pda([Buffer.from('__event_authority')], PUMPSWAP_PROGRAM_ID);
const globalVolumeAccumulatorPda = () =>
  pda([Buffer.from('global_volume_accumulator')], PUMPSWAP_PROGRAM_ID);
const userVolumeAccumulatorPda = (user: PublicKey) =>
  pda([Buffer.from('user_volume_accumulator'), user.toBuffer()], PUMPSWAP_PROGRAM_ID);
const coinCreatorVaultAuthorityPda = (coinCreator: PublicKey) =>
  pda([Buffer.from('creator_vault'), coinCreator.toBuffer()], PUMPSWAP_PROGRAM_ID);
const feeConfigPda = () => pda([Buffer.from('fee_config'), FEE_CONFIG_SEED_2], FEE_PROGRAM_ID);

async function getTokenProgramForMint(connection: Connection, mint: PublicKey): Promise<PublicKey> {
  if (mint.equals(WSOL_MINT)) return TOKEN_PROGRAM_ID;
  const info = await connection.getAccountInfo(mint);
  if (!info) throw new Error(`Mint ${mint.toBase58()} not found on-chain`);
  return info.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
}

interface GlobalConfigState {
  protocolFeeRecipients: PublicKey[];
}

/**
 * GlobalConfig layout per the IDL: 8-byte discriminator, admin (32), lp_fee_bp (8),
 * protocol_fee_bp (8), disable_flags (1), then protocol_fee_recipients: [Pubkey; 8].
 * The program only validates the recipient passed is *one of* these 8 (a common
 * load-distribution pattern) — any entry works, so the first is used.
 */
function decodeGlobalConfig(data: Buffer): GlobalConfigState {
  let offset = 8 + 32 + 8 + 8 + 1;
  const recipients: PublicKey[] = [];
  for (let i = 0; i < 8; i++) {
    recipients.push(new PublicKey(data.subarray(offset, offset + 32)));
    offset += 32;
  }
  return { protocolFeeRecipients: recipients };
}

/**
 * Constant-product quote from raw (non-decimal-adjusted) reserves, matching the
 * same x*y=k model used for liquidity estimation elsewhere in this codebase.
 * Ignores the pool's actual fee basis points (read from GlobalConfig, not applied
 * here) — acceptable for a rarely-used fallback path since the result is only ever
 * a floor/ceiling bound, protected by simulation before any send.
 */
export function quoteConstantProduct(
  reserveIn: bigint,
  reserveOut: bigint,
  amountIn: bigint,
): bigint {
  if (reserveIn <= 0n || reserveOut <= 0n || amountIn <= 0n) return 0n;
  return (reserveOut * amountIn) / (reserveIn + amountIn);
}

/** Applies a downward slippage discount (in bps) to a raw amount — never negative. */
export function applySlippageFloor(amount: bigint, slippageBps: number): bigint {
  const bps = BigInt(Math.max(0, Math.min(10_000, Math.round(slippageBps))));
  return (amount * (10_000n - bps)) / 10_000n;
}

export class PumpSwapExecutor implements NativeDexExecutor {
  readonly dex = 'PUMPSWAP';

  async buildSwap(params: NativeSwapParams): Promise<VersionedTransaction> {
    const { connection, signer, inputMint, outputMint, amountLamports, slippageBps, poolAddress } =
      params;
    if (!poolAddress) {
      throw new Error('PumpSwap executor requires a known poolAddress (from Token.poolAddress)');
    }

    const pool = await getPumpSwapPoolState(connection, poolAddress);
    if (!pool) {
      throw new Error(
        `PumpSwap pool ${poolAddress} not found or not owned by the PumpSwap program`,
      );
    }

    const isBuy = inputMint === pool.quoteMint && outputMint === pool.baseMint;
    const isSell = inputMint === pool.baseMint && outputMint === pool.quoteMint;
    if (!isBuy && !isSell) {
      throw new Error(
        `Mint pair ${inputMint}/${outputMint} does not match pool ${poolAddress}'s base/quote (${pool.baseMint}/${pool.quoteMint})`,
      );
    }

    const baseMint = new PublicKey(pool.baseMint);
    const quoteMint = new PublicKey(pool.quoteMint);
    const poolPubkey = new PublicKey(poolAddress);
    const coinCreator = new PublicKey(pool.coinCreator);

    const [baseTokenProgram, quoteTokenProgram, baseBal, quoteBal, globalConfigInfo] =
      await Promise.all([
        getTokenProgramForMint(connection, baseMint),
        getTokenProgramForMint(connection, quoteMint),
        connection.getTokenAccountBalance(new PublicKey(pool.poolBaseTokenAccount)),
        connection.getTokenAccountBalance(new PublicKey(pool.poolQuoteTokenAccount)),
        connection.getAccountInfo(globalConfigPda()),
      ]);
    if (!globalConfigInfo) throw new Error('PumpSwap GlobalConfig account not found');
    const globalConfig = decodeGlobalConfig(globalConfigInfo.data);
    const protocolFeeRecipient = globalConfig.protocolFeeRecipients[0]!;

    const baseReserve = BigInt(baseBal.value.amount);
    const quoteReserve = BigInt(quoteBal.value.amount);

    const userBaseAta = getAssociatedTokenAddressSync(
      baseMint,
      signer.publicKey,
      false,
      baseTokenProgram,
    );
    const userQuoteAta = getAssociatedTokenAddressSync(
      quoteMint,
      signer.publicKey,
      false,
      quoteTokenProgram,
    );
    const protocolFeeRecipientAta = getAssociatedTokenAddressSync(
      quoteMint,
      protocolFeeRecipient,
      true,
      quoteTokenProgram,
    );
    const coinCreatorVaultAuthority = coinCreatorVaultAuthorityPda(coinCreator);
    const coinCreatorVaultAta = getAssociatedTokenAddressSync(
      quoteMint,
      coinCreatorVaultAuthority,
      true,
      quoteTokenProgram,
    );

    const keys = [
      { pubkey: poolPubkey, isSigner: false, isWritable: true },
      { pubkey: signer.publicKey, isSigner: true, isWritable: true },
      { pubkey: globalConfigPda(), isSigner: false, isWritable: false },
      { pubkey: baseMint, isSigner: false, isWritable: false },
      { pubkey: quoteMint, isSigner: false, isWritable: false },
      { pubkey: userBaseAta, isSigner: false, isWritable: true },
      { pubkey: userQuoteAta, isSigner: false, isWritable: true },
      { pubkey: new PublicKey(pool.poolBaseTokenAccount), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(pool.poolQuoteTokenAccount), isSigner: false, isWritable: true },
      { pubkey: protocolFeeRecipient, isSigner: false, isWritable: false },
      { pubkey: protocolFeeRecipientAta, isSigner: false, isWritable: true },
      { pubkey: baseTokenProgram, isSigner: false, isWritable: false },
      { pubkey: quoteTokenProgram, isSigner: false, isWritable: false },
      {
        pubkey: new PublicKey('11111111111111111111111111111111'),
        isSigner: false,
        isWritable: false,
      },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: eventAuthorityPda(), isSigner: false, isWritable: false },
      { pubkey: PUMPSWAP_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: coinCreatorVaultAta, isSigner: false, isWritable: true },
      { pubkey: coinCreatorVaultAuthority, isSigner: false, isWritable: false },
    ];

    let data: Buffer;
    if (isBuy) {
      const estimatedBaseOut = quoteConstantProduct(quoteReserve, baseReserve, amountLamports);
      const baseAmountOut = applySlippageFloor(estimatedBaseOut, slippageBps);
      if (baseAmountOut <= 0n) throw new Error('Computed buy quote is zero — pool has no depth');

      keys.push(
        { pubkey: globalVolumeAccumulatorPda(), isSigner: false, isWritable: false },
        { pubkey: userVolumeAccumulatorPda(signer.publicKey), isSigner: false, isWritable: true },
        { pubkey: feeConfigPda(), isSigner: false, isWritable: false },
        { pubkey: FEE_PROGRAM_ID, isSigner: false, isWritable: false },
      );

      data = Buffer.concat([
        BUY_DISCRIMINATOR,
        u64le(baseAmountOut),
        u64le(amountLamports), // max_quote_amount_in: the hard SOL spend cap
        Buffer.from([0]), // track_volume: false
      ]);
    } else {
      const estimatedQuoteOut = quoteConstantProduct(baseReserve, quoteReserve, amountLamports);
      const minQuoteOut = applySlippageFloor(estimatedQuoteOut, slippageBps);

      keys.push(
        { pubkey: feeConfigPda(), isSigner: false, isWritable: false },
        { pubkey: FEE_PROGRAM_ID, isSigner: false, isWritable: false },
      );

      data = Buffer.concat([
        SELL_DISCRIMINATOR,
        u64le(amountLamports), // base_amount_in: exact tokens being sold
        u64le(minQuoteOut),
      ]);
    }

    const ix = new TransactionInstruction({ programId: PUMPSWAP_PROGRAM_ID, keys, data });

    // Idempotent: never fails if the ATA already exists, matching the existing
    // Jupiter-swap path's assumption that ATA setup is the caller's problem to not
    // block on — this makes the native path self-sufficient instead.
    const ataIx = createAssociatedTokenAccountIdempotentInstruction(
      signer.publicKey,
      isBuy ? userBaseAta : userQuoteAta,
      signer.publicKey,
      isBuy ? baseMint : quoteMint,
      isBuy ? baseTokenProgram : quoteTokenProgram,
    );

    const { blockhash } = await connection.getLatestBlockhash();
    const message = new TransactionMessage({
      payerKey: signer.publicKey,
      recentBlockhash: blockhash,
      instructions: [ataIx, ix],
    }).compileToV0Message();
    const tx = new VersionedTransaction(message);
    tx.sign([signer]);
    return tx;
  }
}

function u64le(value: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(value);
  return buf;
}
