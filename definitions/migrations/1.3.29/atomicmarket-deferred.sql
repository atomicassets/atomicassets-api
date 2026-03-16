-- Replace the non-covering index with a covering version for index-only scans
-- on the stats/accounts query (UNNEST buyer/seller aggregation).
-- Eliminates 495K heap page reads for alien.worlds (10.4M rows).
DROP INDEX IF EXISTS atomicmarket_stats_markets_contract_symbol_collection_time;

CREATE INDEX CONCURRENTLY IF NOT EXISTS atomicmarket_stats_markets_contract_symbol_collection_time
    ON atomicmarket_stats_markets (market_contract, symbol, collection_name, "time")
    INCLUDE (buyer, seller, price);
