-- Multi-DEX Discovery/Execution balancing: add new Dex enum values for the 3
-- new discovery-only native monitors (Phoenix, Lifinity, FluxBeam).
-- Additive-only — new enum labels, no column/table changes, no backfill
-- needed. Same pattern as 20260712071500_add_discovery_v2_dexs.
ALTER TYPE "Dex" ADD VALUE 'PHOENIX';
ALTER TYPE "Dex" ADD VALUE 'LIFINITY';
ALTER TYPE "Dex" ADD VALUE 'FLUXBEAM';
