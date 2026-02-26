ALTER TABLE atomicmarket_auctions ALTER COLUMN maker_marketplace DROP NOT NULL;
ALTER TABLE atomicmarket_sales ALTER COLUMN maker_marketplace DROP NOT NULL;
ALTER TABLE atomicmarket_buyoffers ALTER COLUMN maker_marketplace DROP NOT NULL;
ALTER TABLE atomicmarket_template_buyoffers ALTER COLUMN maker_marketplace DROP NOT NULL;
ALTER TABLE atomicmarket_stats_markets ALTER COLUMN maker_marketplace DROP NOT NULL;
ALTER TABLE atomicmarket_sales_filters ALTER COLUMN maker_marketplace DROP NOT NULL;
ALTER TABLE atomicmarket_stats_markets ALTER COLUMN taker_marketplace DROP NOT NULL;
