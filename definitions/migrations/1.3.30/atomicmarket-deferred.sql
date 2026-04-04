-- Covers: sales listing CTE ordered by created_at_time DESC within a partition.
-- The table is PARTITION BY LIST (sale_state), so this index is created on each
-- partition and allows the ORDER BY + LIMIT to use an index scan instead of
-- doing a full GIN scan + sort on the filter column.
CREATE INDEX CONCURRENTLY IF NOT EXISTS atomicmarket_sales_filters_market_created_desc
    ON atomicmarket_sales_filters (market_contract, created_at_time DESC, sale_id);
