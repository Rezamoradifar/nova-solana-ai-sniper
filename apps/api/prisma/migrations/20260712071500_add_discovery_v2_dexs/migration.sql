-- Discovery Engine V2: add new Dex enum values for the 3 new native monitors
-- (Raydium CLMM, OpenBook v2, Moonshot). Additive-only — new enum labels, no
-- column/table changes, no backfill needed.
ALTER TYPE "Dex" ADD VALUE 'RAYDIUM_CLMM';
ALTER TYPE "Dex" ADD VALUE 'OPENBOOK';
ALTER TYPE "Dex" ADD VALUE 'MOONSHOT';
