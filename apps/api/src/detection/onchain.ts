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
 */
export async function getHolderConcentration(
  connection: Connection,
  mint: string,
): Promise<HolderConcentration> {
  const mintPubkey = new PublicKey(mint);
  const largest = await connection.getTokenLargestAccounts(mintPubkey);
  const supply = await connection.getTokenSupply(mintPubkey);

  const totalSupply = Number(supply.value.amount);
  if (totalSupply === 0) {
    return { top10HolderPercent: 0, holderCount: 0 };
  }

  const top10 = largest.value.slice(0, 10).reduce((sum, acc) => sum + Number(acc.amount), 0);

  return {
    top10HolderPercent: (top10 / totalSupply) * 100,
    holderCount: largest.value.filter((a) => Number(a.amount) > 0).length,
  };
}
