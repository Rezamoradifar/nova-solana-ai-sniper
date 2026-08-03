-- Hard Loss Ceiling: distinguishes a position whose stopLossPercent is the
-- 20% system default/ceiling from one where the user's own tighter value is
-- in effect. Additive-only — every existing row gets false (accurate: prior
-- to this change, nothing enforced stopLossPercent as an actual ceiling).
ALTER TABLE "positions" ADD COLUMN "stopLossIsSystemDefault" BOOLEAN NOT NULL DEFAULT false;
