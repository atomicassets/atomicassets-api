/*
  1.3.35 - Per-table autovacuum + fillfactor on
  atomicmarket_sales_filters_updates so its heap stops bloating.

  Background:
    atomicmarket_sales_filters_updates is the work queue for
    update_atomicmarket_sales_filters(): handlers INSERT changed
    (asset_id | sale_id | offer_id) rows, the maintenance function
    DELETE...RETURNINGs them every ~80s. Steady-state queue depth is
    in the hundreds of rows; the function takes ~1s when the table
    is dense.

    Observed on a busy WAX deployment 2026-05-03: total relation size
    grew to 98 MB while only 172 rows were live (autovacuum_count was
    already 26,630, n_dead_tup was 0). The bloat lived almost entirely
    in the three partial indexes on (market_contract, sale_id),
    (asset_contract, asset_id), (asset_contract, offer_id) — autovacuum
    reclaims dead tuples but does not return empty heap or index pages
    to the OS. Each maintenance call then scanned a sparse partial
    index to find a handful of live rows; observed function durations
    were 17-35 seconds, which queued user-facing /atomicmarket/v2/sales
    queries behind the same partition reads and tripped a >18s
    read-timeout on the API.

    Reclamation only happens via a one-shot rebuild — VACUUM FULL
    (ACCESS EXCLUSIVE for ms-scale on a tiny live set) or
    REINDEX INDEX CONCURRENTLY on the bloated indexes (no locks if
    heap is empty, which is the case after the function processes
    its backlog). Operators run that out of band when bloat is
    detected; this migration tunes the table so the bloat plateaus
    sooner instead.

  Settings:
    autovacuum_vacuum_scale_factor    = 0.0  )  fire on absolute
    autovacuum_vacuum_threshold       = 100  )  dead-tuple count, not
    autovacuum_analyze_scale_factor   = 0.0  )  relative to a tiny
    autovacuum_analyze_threshold      = 100  )  live set
    fillfactor                        = 80   -- HOT-update headroom

    Without scale_factor=0, the cluster default
    (autovacuum_vacuum_scale_factor=0.2 + autovacuum_vacuum_threshold
    = 50 + 0.2 * n_live_tup) only fires when dead_tup exceeds a
    moving fraction of live_tup; on a queue with live_tup < 1000 that
    threshold is constantly chasing the workload. Pinning to absolute
    counts gates autovacuum on the metric that actually matters here.

  Operator note:
    This migration only changes thresholds, not table contents. It
    does NOT shrink an already-bloated heap or indexes. If
    pg_total_relation_size('atomicmarket_sales_filters_updates') is
    much larger than (n_live_tup * row_width), schedule a one-shot
    rebuild on the deployment:

        -- Heap + indexes (brief ACCESS EXCLUSIVE, ms-scale on a tiny
        -- live set; safe even on tier1 prod):
        VACUUM (FULL, ANALYZE) atomicmarket_sales_filters_updates;

        -- Or, when the queue is empty (heap = 0 bytes) and only
        -- indexes are bloated, no locks at all:
        REINDEX INDEX CONCURRENTLY market_sales_updates_asset_id;
        REINDEX INDEX CONCURRENTLY market_sales_updates_sale_id;
        REINDEX INDEX CONCURRENTLY market_sales_updates_offer_id;
*/

ALTER TABLE atomicmarket_sales_filters_updates SET (
  autovacuum_vacuum_scale_factor    = 0.0,
  autovacuum_vacuum_threshold       = 100,
  autovacuum_analyze_scale_factor   = 0.0,
  autovacuum_analyze_threshold      = 100,
  fillfactor                        = 80
);

UPDATE dbinfo SET "value" = '1.3.35' WHERE name = 'version';
