/*
  1.7.0 - Drop unused indexes (replica-verified).

  Removes 6 indexes that are unused on BOTH the primary and the replica across
  every ECA chain over a 26-30 day window (idx_scan=0 on each instance, no
  matching pg_stat_statements caller). Reclaims ~1.6 GB on WAX-mainnet and cuts
  index write-amplification per block mutation (one fewer index to maintain on
  each affected table) - part of the WAX filler burst-resilience work.

  IMPORTANT - these were verified against the REPLICA, not just the primary:
  API reads route to the replica (pooler-ro) while the primary mostly serves the
  filler's writes, so an audit that only reads the primary's idx_scan falsely
  flags read-serving indexes. The 2026-05-27 audit's 14-index "SAFE" set was
  primary-only; re-checking the replica showed 6 of those 14 are actually USED
  (incl. the 6.4 GB atomicassets_assets_contract_minted_at_time, 101 scans) and
  are KEPT. atomicmarket_sales_buyer + atomicmarket_sales_state are also KEPT
  (used on proton-mainnet) to avoid per-chain schema divergence. Only the 6
  unused-on-every-chain indexes are dropped here; the corresponding CREATE INDEX
  statements are removed from definitions/tables/{atomicmarket,atomictools}_tables.sql
  so fresh DBs don't recreate them.

  Metadata-only DDL (DROP INDEX IF EXISTS). Non-concurrent is safe: migrations run
  at filler startup before the reader connects to SHIP, so the brief lock has no
  reader to contend with; on existing primaries the indexes were pre-dropped
  CONCURRENTLY (IF EXISTS -> no-op, no lock). No deferred file needed.

  atomicassets_template_counts_contract_template_id was DROPped in 1.3.15 but
  drifted back on some DBs; the IF EXISTS here cleans up that drift too.
*/

UPDATE dbinfo SET "value" = '1.7.0' WHERE name = 'version';
