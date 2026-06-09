/*
  1.7.13 - see atomicmarket.sql: opt-in partition-parallel drain for large
  atomicmarket_sales_filters_updates backlogs (post-catchup / bulk-load recovery),
  plus an index on atomicmarket_sales_filters (assets_contract, offer_id) so the
  drain's offer->sales resolution is index probes instead of a per-batch scan of
  the (multi-GB) filter partitions. No cross-handler schema change in this file.
*/

UPDATE dbinfo SET "value" = '1.7.13' WHERE name = 'version';
