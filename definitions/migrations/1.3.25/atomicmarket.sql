ALTER TABLE atomicmarket_auctions ALTER COLUMN maker_marketplace DROP NOT NULL;
ALTER TABLE atomicmarket_sales ALTER COLUMN maker_marketplace DROP NOT NULL;
ALTER TABLE atomicmarket_buyoffers ALTER COLUMN maker_marketplace DROP NOT NULL;
ALTER TABLE atomicmarket_template_buyoffers ALTER COLUMN maker_marketplace DROP NOT NULL;
ALTER TABLE atomicmarket_stats_markets ALTER COLUMN maker_marketplace DROP NOT NULL;
ALTER TABLE atomicmarket_sales_filters ALTER COLUMN maker_marketplace DROP NOT NULL;

UPDATE atomicmarket_auctions SET maker_marketplace = NULL WHERE maker_marketplace = '';
UPDATE atomicmarket_sales SET maker_marketplace = NULL WHERE maker_marketplace = '';
UPDATE atomicmarket_buyoffers SET maker_marketplace = NULL WHERE maker_marketplace = '';
UPDATE atomicmarket_template_buyoffers SET maker_marketplace = NULL WHERE maker_marketplace = '';
UPDATE atomicmarket_stats_markets SET maker_marketplace = NULL WHERE maker_marketplace = '';
UPDATE atomicmarket_sales_filters SET maker_marketplace = NULL WHERE maker_marketplace = '';
