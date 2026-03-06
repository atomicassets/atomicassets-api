-- Partial unique index: only one consolidated row (dirty IS NULL) per key combo.
-- Prevents duplicate stats from pgdump restore or aggregation races.
CREATE UNIQUE INDEX IF NOT EXISTS atomicassets_asset_counts_unique_consolidated
ON atomicassets_asset_counts (contract, collection_name, schema_name, template_id)
WHERE dirty IS NULL;
