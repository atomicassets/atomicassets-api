UPDATE atomicmarket_stats_markets SET maker_marketplace = NULL WHERE maker_marketplace = '';
UPDATE atomicmarket_template_buyoffers SET maker_marketplace = NULL WHERE maker_marketplace = '';
UPDATE atomicmarket_sales SET maker_marketplace = NULL WHERE maker_marketplace = '';
