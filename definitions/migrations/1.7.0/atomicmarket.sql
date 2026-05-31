-- 1.7.0 - drop unused atomicmarket indexes (replica-verified zero-scan on every chain).
-- See 1.7.0/database.sql for the rationale + the KEEP list (sales_buyer, sales_state,
-- template_buyoffers_mc_state_created, buyoffers_mc_state_created, etc. are USED — not dropped).

DROP INDEX IF EXISTS atomicmarket_stats_markets_price;
DROP INDEX IF EXISTS atomicmarket_stats_markets_taker_mp;
DROP INDEX IF EXISTS atomicmarket_template_buyoffers_updated_at_time;
DROP INDEX IF EXISTS atomicmarket_sales_filters_sold_maker_mp;
