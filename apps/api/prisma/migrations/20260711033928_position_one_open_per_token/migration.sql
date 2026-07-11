-- DB-level backstop for the app-level duplicate-buy guard added to
-- TradingSafety.checkBeforeOpen: at most one OPEN position per (walletId,
-- tokenId). A partial unique index (not expressible in schema.prisma's DSL,
-- Prisma has no WHERE-clause index support) so historical CLOSED positions
-- for the same wallet+token are unaffected and can still accumulate freely.
--
-- Safe to apply: verified against production data before this migration was
-- written — zero existing duplicate OPEN (walletId, tokenId) pairs.
CREATE UNIQUE INDEX "positions_wallet_token_open_unique"
  ON "positions" ("walletId", "tokenId")
  WHERE "status" = 'OPEN';
