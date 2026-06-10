/*
  2.0.1 - see atomicmarket.sql: opt-in partition-parallel drain for large
  atomicmarket_sales_filters_updates backlogs (post-catchup / bulk-load recovery),
  plus an index on atomicmarket_sales_filters (assets_contract, offer_id) so the
  drain's offer->sales resolution is index probes instead of a per-batch scan of
  the (multi-GB) filter partitions. No cross-handler schema change in this file.

  (Port of the 1.7.13 migration from the main-line PR #71, renumbered 2.0.1 so
  it sorts after 2.0.0 and still applies to databases already initialized from
  the 2.0.0-rc tags.)
*/

UPDATE dbinfo SET "value" = '2.0.1' WHERE name = 'version';
