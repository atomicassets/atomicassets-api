-- Covers: sales listing CTE ordered by created_at_time DESC within a partition.
-- The table is PARTITION BY LIST (sale_state); defining the index on the parent
-- cascades it to every partition and lets the ORDER BY + LIMIT use an index scan
-- instead of a full GIN scan + sort on the filter column.
--
-- NOT CONCURRENTLY: Postgres rejects CREATE INDEX CONCURRENTLY on a partitioned
-- parent ("cannot create index on partitioned table ... concurrently"), so the
-- original CONCURRENTLY form always errored here and was skipped (the deferred
-- runner bumps dbinfo before running this, so a throw is never retried). The only
-- path that still replays 1.3.30 is a from-scratch install, where the table is
-- empty and a plain CREATE INDEX is instant; existing deployments are already
-- past 1.3.30 and never re-run it.
CREATE INDEX IF NOT EXISTS atomicmarket_sales_filters_market_created_desc
    ON atomicmarket_sales_filters (market_contract, created_at_time DESC, sale_id);
