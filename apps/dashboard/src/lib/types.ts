export interface Token {
  id: string;
  mint: string;
  symbol?: string | null;
  name?: string | null;
  dex: 'PUMPFUN' | 'RAYDIUM' | 'ORCA' | 'JUPITER';
  liquidityUsd?: number | null;
  marketCapUsd?: number | null;
  aiScore?: number | null;
  aiSummary?: string | null;
  isHoneypotSuspected?: boolean | null;
  createdAt: string;
}

export interface Trade {
  id: string;
  side: 'BUY' | 'SELL';
  status: 'PENDING' | 'CONFIRMED' | 'FAILED';
  amountSol: number;
  priceUsd?: number | null;
  txSignature?: string | null;
  createdAt: string;
  token: Token;
}

export interface Position {
  id: string;
  status: 'OPEN' | 'CLOSED';
  entryPriceUsd: number;
  amountToken: number;
  amountSolInvested: number;
  takeProfitPercent?: number | null;
  stopLossPercent?: number | null;
  trailingStopPercent?: number | null;
  realizedPnlUsd?: number | null;
  createdAt: string;
  token: Token;
}

export interface SnipeConfig {
  id: string;
  isActive: boolean;
  buyAmountSol: number;
  maxSlippageBps: number;
  minLiquidityUsd: number;
  minAiScore: number;
  takeProfitPercent?: number | null;
  stopLossPercent?: number | null;
  trailingStopPercent?: number | null;
  autoBuyOnLaunch: boolean;
}

export interface Wallet {
  id: string;
  label: string;
  publicKey: string;
  isActive: boolean;
  createdAt: string;
}

/** Returned only from POST /wallets — `mnemonic` is shown once and never persisted. */
export interface WalletCreateResult extends Wallet {
  mnemonic?: string;
}

/** AES-256-GCM-encrypted wallet backup file — useless without the password used to create it. */
export interface WalletBackupFile {
  version: number;
  kind: string;
  publicKey: string;
  createdAt: string;
  salt: string;
  iv: string;
  authTag: string;
  ciphertext: string;
}

export interface PortfolioSummary {
  walletId: string;
  openPositions: number;
  totalInvestedSol: number;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
}

export interface LeaderboardEntry {
  walletId: string;
  publicKey: string;
  label: string;
  realizedPnlUsd: number;
  closedTrades: number;
}

export interface CurrentUser {
  id: string;
  email: string | null;
  role: 'ADMIN' | 'TRADER';
}
