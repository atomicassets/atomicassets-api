-- Per-contract marker recording that the v2 late-upgrader guard is satisfied
-- for this atomicassets contract (see AtomicAssetsHandler.init and
-- processors/config.ts). NULL means "unproven": either the contract never
-- crossed the v2 flip while this indexer read it, or it did and no confirming
-- event (a live tokenconfigs delta, a reconcile run, or an operator override)
-- has recorded it yet. The column is metadata-only and instant to add.
ALTER TABLE atomicassets_config ADD COLUMN IF NOT EXISTS v2_marker_block bigint;
