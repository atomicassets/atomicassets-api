/*
  1.3.33 - Reset autovacuum insert-threshold overrides so autovacuum
  actually runs on the atomicassets hot tables.

  Background:
    last_vacuum / last_autovacuum on eca-wax-mainnet-cluster-3 were NULL
    for atomicassets_offers_assets (315M rows, 673 dead tuples) and
    atomicassets_offers (181M rows, 68K dead tuples). Autovacuum had
    literally never fired on these tables in the life of the cluster.

    Consequence: the visibility map is never refreshed, so index-only
    scans on the existing composite index
    (atomicassets_offers_assets_asset_contract_offer_idx on asset_id,
    contract, offer_id) are disqualified by the planner. The offer-
    invalidation query at offers.ts:146 falls back to a single-column
    asset_id index + heap fetch, which busts the 180s statement_timeout
    on cold Cinder cache - observed 2026-04-24 12:10 UTC at block
    #431099975 when a batch of 4 asset_ids (one with 5,820 rows)
    triggered ~3,256 nested-loop probes.

  Prior per-table overrides:
    autovacuum_vacuum_insert_threshold = 1000000  -- far too high to fire
    autovacuum_vacuum_threshold        = 100000   -- dead-tuple gate, fine
    autovacuum_analyze_threshold       = 100000   -- fires (last_analyze set)

  Reset only the insert threshold back to the cluster default (1000 +
  scale-factor 0.2). With 315M rows that means insert-driven autovacuum
  fires roughly every 63M new inserts, which keeps the visibility map
  fresh without overwhelming the primary.

  Keep autovacuum_vacuum_threshold and autovacuum_analyze_threshold as-is
  - those gate dead-tuple-driven vacuum and ANALYZE respectively; the
  100000 threshold there is intentional throttle.

  A one-time manual VACUUM is run separately before/alongside this
  migration to seed the visibility map; after that, insert-driven
  autovacuum takes over.
*/

ALTER TABLE atomicassets_offers_assets     RESET (autovacuum_vacuum_insert_threshold);
ALTER TABLE atomicassets_offers            RESET (autovacuum_vacuum_insert_threshold);
ALTER TABLE atomicassets_transfers_assets  RESET (autovacuum_vacuum_insert_threshold);

UPDATE dbinfo SET "value" = '1.3.33' WHERE name = 'version';
