CREATE INDEX CONCURRENTLY IF NOT EXISTS atomicmarket_stats_markets_contract_symbol_collection_time
    ON atomicmarket_stats_markets (market_contract, symbol, collection_name, "time");
