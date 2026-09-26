/** Mirrors GET /auth/me's real response shape exactly (apps/api/src/routes/auth.ts) —
 * richer than apps/dashboard's CurrentUser type, which is missing subscriptionTier/
 * referralCode; not reused from there since that type is stale versus the real route. */
export interface CurrentUser {
  id: string;
  email: string | null;
  role: 'ADMIN' | 'TRADER';
  /** True for TELEGRAM_ADMIN_IDS members (or a DB ADMIN) — shows the Admin screen. */
  isAdmin?: boolean;
  subscriptionTier: 'FREE' | 'PRO';
  referralCode: string | null;
}

/** Verified against apps/api/prisma/schema.prisma's real Trade model + GET
 * /trades (apps/api/src/routes/trades.ts returns the raw Prisma row +
 * `include: { token: true }`, flat `take: 100`, no offset — see
 * MISSING_APIS.md #7 for the real pagination gap). */
export interface Trade {
  id: string;
  side: 'BUY' | 'SELL';
  status: 'PENDING' | 'CONFIRMED' | 'FAILED';
  amountSol: number;
  amountToken: number | null;
  priceUsd: number | null;
  txSignature: string | null;
  slippageBps: number;
  isPaperTrade: boolean;
  createdAt: string;
  confirmedAt: string | null;
  token: Token;
}

/** Verified against apps/api/prisma/schema.prisma's SnipeConfig model + GET
 * /snipes (apps/api/src/routes/snipes.ts returns the raw Prisma row). This
 * is a per-token/per-config CRUD resource, not a single account-level
 * trading-controls toggle — see MISSING_APIS.md #10. */
export interface SnipeConfig {
  id: string;
  tokenId: string | null;
  isActive: boolean;
  buyAmountSol: number;
  maxSlippageBps: number;
  minLiquidityUsd: number;
  minAiScore: number;
  takeProfitPercent: number | null;
  stopLossPercent: number | null;
  trailingStopPercent: number | null;
  autoBuyOnLaunch: boolean;
  createdAt: string;
}

/** Verified against apps/dashboard/src/lib/types.ts + apps/api/prisma/schema.prisma's
 * real Dex enum (API_CONTRACT.md's "TypeScript shapes already verified against
 * production use") — the dashboard's own Dex union is stale, so the full schema
 * enum is used here instead of copying that staleness forward. */
export type Dex =
  | 'PUMPFUN'
  | 'PUMPSWAP'
  | 'RAYDIUM'
  | 'RAYDIUM_CLMM'
  | 'ORCA'
  | 'JUPITER'
  | 'METEORA'
  | 'OPENBOOK'
  | 'MOONSHOT'
  | 'PHOENIX'
  | 'LIFINITY'
  | 'FLUXBEAM';

/** Extended past API_CONTRACT.md's baseline shape with fields verified
 * directly against apps/api/prisma/schema.prisma's real Token model (GET
 * /tokens returns the raw Prisma row, no field selection) — holderCount/
 * top10HolderPercent/imageUrl/authority+LP flags all exist on the wire today,
 * just weren't needed until the Discovery/Signals/token-row work. No
 * "volume" or "migrated" field exists on Token — do not invent one; see
 * MISSING_APIS.md. */
export interface Token {
  id: string;
  mint: string;
  symbol?: string | null;
  name?: string | null;
  dex: Dex;
  liquidityUsd?: number | null;
  marketCapUsd?: number | null;
  aiScore?: number | null;
  aiSummary?: string | null;
  isHoneypotSuspected?: boolean | null;
  /** DexScreener's pair.info.imageUrl — the token's real logo, when DexScreener has one. */
  imageUrl?: string | null;
  /** Count of non-zero accounts among the top-20-largest holders read — a
   * real signal, not a true total holder count (mirrors the trade card's
   * own "Top Holders" framing, not "Total Holders"). */
  holderCount?: number | null;
  top10HolderPercent?: number | null;
  mintAuthorityRevoked?: boolean | null;
  freezeAuthorityRevoked?: boolean | null;
  lpBurnedOrLocked?: boolean | null;
  createdAt: string;
}

export interface Wallet {
  id: string;
  label: string;
  publicKey: string;
  isActive: boolean;
  createdAt: string;
  lastKnownBalanceLamports: string | null;
  balanceUpdatedAt: string | null;
}

/** Verified against apps/api/src/routes/wallets.ts's serializeLedgerEntry —
 * BigInt fields are pre-serialized to strings server-side. */
export interface LedgerEntry {
  id: string;
  type:
    | 'DEPOSIT'
    | 'WITHDRAWAL'
    | 'REFERRAL_CREDIT'
    | 'PROFIT_CREDIT'
    | 'OWNER_FEE'
    | 'LEDGER_ADJUSTMENT';
  asset: 'SOL' | 'USD';
  direction: 'CREDIT' | 'DEBIT';
  amountLamports: string | null;
  amountUsd: number | null;
  balanceAfterLamports: string | null;
  txSignature: string | null;
  status: 'SUCCESS' | 'FAILED' | 'PENDING';
  referenceType: string | null;
  referenceId: string | null;
  createdAt: string;
}

/** Verified against apps/api/prisma/schema.prisma's AuditLog model + GET
 * /wallets/:id/audit-log (returns the raw Prisma row). */
export interface AuditLogEntry {
  id: string;
  userId: string | null;
  walletId: string | null;
  action: string;
  status: 'SUCCESS' | 'FAILED';
  txSignature: string | null;
  metadata: unknown;
  ip: string | null;
  createdAt: string;
}

/** Verified against packages/shared/src/security/backup.ts's WalletBackup —
 * a portable, password-encrypted file; the plaintext secret never appears
 * in this shape. */
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

/** GET /portfolio actually returns one summary PER WALLET, not a single
 * object — API_CONTRACT.md's original doc was wrong on this point (only
 * checked against a stale assumption, not the real route source/the
 * dashboard's own already-working `api.get<PortfolioSummary[]>('/portfolio')`
 * usage). A user can have multiple wallets, so every consumer must aggregate
 * across this array, never index [0] and drop the rest. */
export type PortfolioSummaryList = PortfolioSummary[];

/** Verified against apps/api/prisma/schema.prisma's real Position model +
 * GET /positions (apps/api/src/routes/positions.ts returns the raw Prisma
 * row + `include: { token: true }`, no field selection) — every field below
 * exists on the wire today; institutional-mode-only fields are typed
 * nullable since most positions predate/don't use that mode.
 *
 * currentPriceUsd/unrealizedPnlUsd are a 2026-07-14 addition to the route,
 * present only on OPEN positions and only when a live DexScreener price was
 * available that request — null otherwise, never a fabricated number. */
export interface Position {
  id: string;
  status: 'OPEN' | 'CLOSED';
  entryPriceUsd: number;
  amountToken: number;
  amountSolInvested: number;
  takeProfitPercent: number | null;
  stopLossPercent: number | null;
  trailingStopPercent: number | null;
  realizedPnlUsd: number | null;
  isPaperTrade: boolean;
  closedAt: string | null;
  createdAt: string;
  remainingAmountToken: number | null;
  institutionalModeEnabled: boolean;
  exitReason: string | null;
  riskScoreAtEntry: number | null;
  currentPriceUsd?: number | null;
  unrealizedPnlUsd?: number | null;
  token: Token;
}

/** GET /admin/overview (apps/api/src/routes/admin.ts). */
export interface AdminOverview {
  settings: {
    treasuryWalletAddress: string | null;
    envTreasuryWalletAddress: string;
    performanceFeeBps: number;
    referralProgramEnabled: boolean;
    referralLevels: { level: number; percentBps: number; enabled: boolean }[];
  };
  trading: {
    mode: 'LIVE' | 'PAPER' | null;
    killSwitch: boolean;
    autoBuyPaused: boolean;
    autoBuyPausedReason: string | null;
    activeSnipeConfigs: number;
  };
  stats: {
    users: number;
    newUsers24h: number;
    openPositions: number;
    trades24h: number;
    totalTrades: number;
    volumeSol24h: number;
    volumeSolTotal: number;
    feeRevenueUsd: number;
    referralPaidUsd: number;
  };
  health: {
    scannerState: string | null;
    activeProvider: string | null;
    tokens10m: number;
    tokens24h: number;
  };
}
