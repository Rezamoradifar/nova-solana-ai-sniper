import { Connection, PublicKey } from '@solana/web3.js';
import { getMint } from '@solana/spl-token';

export interface MintAuthorityInfo {
  mintAuthorityRevoked: boolean;
  freezeAuthorityRevoked: boolean;
  decimals: number;
  supply: bigint;
}

export async function getMintAuthorityInfo(
  connection: Connection,
  mint: string,
): Promise<MintAuthorityInfo> {
  const mintInfo = await getMint(connection, new PublicKey(mint));
  return {
    mintAuthorityRevoked: mintInfo.mintAuthority === null,
    freezeAuthorityRevoked: mintInfo.freezeAuthority === null,
    decimals: mintInfo.decimals,
    supply: mintInfo.supply,
  };
}

export interface HolderConcentration {
  top10HolderPercent: number;
  holderCount: number;
}

/**
 * Approximates holder concentration using the largest-token-accounts RPC call
 * (capped at 20 by the RPC itself). Good enough as a rug-risk signal without
 * needing a full indexer.
 *
 * `totalSupplyRaw` is the mint's raw total supply — callers already fetch this
 * via `getMintAuthorityInfo`'s `getMint()` call (same on-chain mint account
 * `getTokenSupply` would otherwise re-read), so it's threaded in here instead
 * of this function issuing its own redundant `getTokenSupply` RPC call.
 *
 * `excludeAddresses` filters out known non-holder accounts (an AMM pool's own
 * token vaults, or the pump.fun bonding curve's vault pre-migration) before
 * ranking the top 10 — without this, the pool/curve itself is usually the
 * single largest "holder" by construction, inflating top10HolderPercent for
 * every token with real on-chain liquidity. Callers resolve these via
 * `DexRegistry.getVaultAddresses` (post-migration) or
 * `getBondingCurveVaultAta` (pre-migration) — see riskAnalyzer.ts.
 */
export async function getHolderConcentration(
  connection: Connection,
  mint: string,
  totalSupplyRaw: bigint,
  excludeAddresses: string[] = [],
): Promise<HolderConcentration> {
  const mintPubkey = new PublicKey(mint);
  const largest = await connection.getTokenLargestAccounts(mintPubkey);

  const totalSupply = Number(totalSupplyRaw);
  if (totalSupply === 0) {
    return { top10HolderPercent: 0, holderCount: 0 };
  }

  const excluded = new Set(excludeAddresses);
  const realHolders = largest.value.filter((a) => !excluded.has(a.address.toBase58()));

  const top10 = realHolders.slice(0, 10).reduce((sum, acc) => sum + Number(acc.amount), 0);

  return {
    top10HolderPercent: (top10 / totalSupply) * 100,
    holderCount: realHolders.filter((a) => Number(a.amount) > 0).length,
  };
}
