/*
  1.3.31 - B-tree indexes for rollback-path point lookups.

  Run manually BEFORE the migration to avoid blocking filler startup:

    SET statement_timeout = 0;

    CREATE INDEX CONCURRENTLY IF NOT EXISTS
      contract_traces_global_sequence_account_idx
      ON contract_traces (global_sequence, account);

    CREATE INDEX CONCURRENTLY IF NOT EXISTS
      atomicassets_offers_assets_asset_contract_offer_idx
      ON atomicassets_offers_assets (asset_id, contract, offer_id);

    ANALYSE contract_traces;
    ANALYSE atomicassets_offers_assets;

  Rationale:

  contract_traces has only BRIN + GIN indexes (1.3.9 removed the B-tree primary
  key to reclaim ~24GB of disk). BRIN is optimised for range scans; point
  lookups fall back to scanning every row in a BRIN-tagged page range. The
  filler's rollback path DELETEs by (global_sequence, account) - on a fork this
  becomes hundreds to thousands of slow point-lookups in one transaction and
  busts statement_timeout, wedging the filler.

  The new B-tree (global_sequence, account) gives sub-millisecond point
  lookups for both DELETE and SELECT from this path. Cost: roughly 20-50 GB
  added per chain; acceptable given the operational impact of stuck fillers
  during ship snapshots and fork events.

  Non-unique intentionally: the 1.3.9 migration dropped the original PK
  (which enforced uniqueness on the same columns) without adding a
  replacement, and the filler's ON CONFLICT ... DO NOTHING path skips the
  conflict clause when no unique constraint exists, so we cannot assume the
  data is still strictly unique today. We can promote to UNIQUE in a
  follow-up once a dedup audit confirms safety; for the rollback use case
  a non-unique B-tree is equally fast.

  atomicassets_offers_assets currently has single-column btrees on asset_id,
  offer_id, owner. A recurring slow-query pattern is:

    WHERE asset.asset_id = ANY ($1)
    RETURNING (contract, offer_id)

  Today Postgres does Index Scan on asset_id → Table Heap Fetch per match.
  The composite (asset_id, contract, offer_id) makes it an Index Only Scan,
  eliminating heap I/O for this pattern. MEMORY.md
  (feedback_eosio_missing_composite_index.md) flagged this as a P1 if stalls
  recur - they did on 2026-04-21.

  The CONCURRENTLY variant above is the actual rollout path. The fallback
  below ensures the indexes exist if a greenfield deployment skips the
  manual step.
*/

CREATE INDEX IF NOT EXISTS
  contract_traces_global_sequence_account_idx
  ON contract_traces (global_sequence, account);

CREATE INDEX IF NOT EXISTS
  atomicassets_offers_assets_asset_contract_offer_idx
  ON atomicassets_offers_assets (asset_id, contract, offer_id);

ANALYSE contract_traces;
ANALYSE atomicassets_offers_assets;

UPDATE dbinfo SET "value" = '1.3.31' WHERE name = 'version';
