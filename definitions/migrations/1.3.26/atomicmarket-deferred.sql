-- P1: Stats endpoint composite (47M rows, 21 GB table)
-- Every stats API query filters market_contract + symbol with time ranges
CREATE INDEX CONCURRENTLY IF NOT EXISTS atomicmarket_stats_markets_contract_symbol_time
    ON atomicmarket_stats_markets (market_contract, symbol, "time");

-- P1: Sales listing composite (171M rows, 65 GB table)
-- v1 sales handler: market_contract + state + ORDER BY created_at_time
CREATE INDEX CONCURRENTLY IF NOT EXISTS atomicmarket_sales_mc_state_created
    ON atomicmarket_sales (market_contract, state, created_at_time DESC, sale_id)
    WHERE state IN (1, 3);

-- P1: Marketplace partial indexes (~0.7% non-NULL, tiny indexes)
CREATE INDEX CONCURRENTLY IF NOT EXISTS atomicmarket_stats_markets_maker_mp
    ON atomicmarket_stats_markets (maker_marketplace)
    WHERE maker_marketplace IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS atomicmarket_stats_markets_taker_mp
    ON atomicmarket_stats_markets (taker_marketplace)
    WHERE taker_marketplace IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS atomicmarket_sales_filters_listed_maker_mp
    ON atomicmarket_sales_filters_listed (maker_marketplace)
    WHERE maker_marketplace IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS atomicmarket_sales_filters_sold_maker_mp
    ON atomicmarket_sales_filters_sold (maker_marketplace)
    WHERE maker_marketplace IS NOT NULL;

-- P2: Listing endpoint composites
-- buyoffers (3.8M rows)
CREATE INDEX CONCURRENTLY IF NOT EXISTS atomicmarket_buyoffers_mc_state_created
    ON atomicmarket_buyoffers (market_contract, state, created_at_time DESC, buyoffer_id);

-- auctions (1.8M rows)
CREATE INDEX CONCURRENTLY IF NOT EXISTS atomicmarket_auctions_mc_state_created
    ON atomicmarket_auctions (market_contract, state, created_at_time DESC, auction_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS atomicmarket_auctions_mc_state_endtime
    ON atomicmarket_auctions (market_contract, state, end_time DESC, auction_id)
    WHERE state = 1;

-- template_buyoffers (5.6M rows)
CREATE INDEX CONCURRENTLY IF NOT EXISTS atomicmarket_template_buyoffers_mc_state_created
    ON atomicmarket_template_buyoffers (market_contract, state, created_at_time DESC, buyoffer_id);

-- P2: Sales stats partial index for getStatsSalesAction aggregations
CREATE INDEX CONCURRENTLY IF NOT EXISTS atomicmarket_sales_sold_stats
    ON atomicmarket_sales (market_contract, settlement_symbol, collection_name)
    INCLUDE (final_price)
    WHERE state = 3;
