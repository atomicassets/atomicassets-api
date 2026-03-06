-- Unique constraint on mints: each asset can only have one mint record.
-- Built concurrently to avoid long locks on this ~469M row table.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS atomicassets_mints_unique
ON atomicassets_mints (contract, asset_id);
