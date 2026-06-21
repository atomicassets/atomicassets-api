/*
  1.3.35 - Per-table autovacuum thresholds on
  atomicmarket_sales_filters_updates so the queue stays clean and the
  planner sees fresh statistics.

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
    (asset_contract, asset_id), (asset_contract, offer_id) - autovacuum
    reclaims dead tuples but does not return empty heap or index pages
    to the OS. Each maintenance call then scanned a sparse partial
    index to find a handful of live rows; observed function durations
    were 17-35 seconds, which queued user-facing /atomicmarket/v2/sales
    queries behind the same partition reads and tripped a >18s
    read-timeout on the API.

    Reclamation only happens via a one-shot rebuild - VACUUM FULL
    (ACCESS EXCLUSIVE for ms-scale on a tiny live set) or
    REINDEX INDEX CONCURRENTLY on the bloated indexes (no locks if
    heap is empty, which is the case after the function processes
    its backlog). Operators run that out of band when bloat is
    detected; this migration tunes the table so the bloat plateaus
    sooner instead.

  Settings (mirror the values that have been running on every ECA DB
  on the blockchain cluster since the 2026-05-03 incident, applied
  out-of-band via direct ALTER TABLE):

    autovacuum_vacuum_scale_factor          = 0.05  )
    autovacuum_vacuum_threshold             = 50    )  see notes below
    autovacuum_analyze_scale_factor         = 0.05  )
    autovacuum_analyze_threshold            = 500   )
    autovacuum_vacuum_insert_scale_factor   = 0.05  )
    autovacuum_vacuum_insert_threshold      = 500   )

    No fillfactor change here: the workload on this specific table
    is INSERT-then-DELETE only (no UPDATE statements against
    atomicmarket_sales_filters_updates exist in src/ or definitions/),
    so HOT updates can never occur and a lower table-level fillfactor
    would just waste page space without helping. The bloat we're
    chasing lives in the partial INDEXES, not the heap; index density
    is governed by per-index fillfactor (btree default 90) and
    addressed via the REINDEX CONCURRENTLY operator-note below.

    The cluster defaults
    (autovacuum_vacuum_scale_factor=0.2 + autovacuum_vacuum_threshold
    = 50 + 0.2 * reltuples) only fire when n_dead_tup exceeds 20 % of
    the *estimated* live-row count. On a queue that holds ~hundreds
    of rows that trigger floats just above n_dead_tup forever - vacuum
    only fires when the queue is *full*, which is exactly the worst
    moment. Pinning scale_factor to 0.05 (1/4 of default) collapses
    the moving target to something close to a fixed lower bound while
    still letting it scale up if the queue ever runs hot.

    autovacuum_vacuum_insert_* is the load-bearing setting here. For
    this workload rows arrive constantly and are DELETE'd in batches,
    so the dead-tuple trigger is bursty (nothing dead between drains,
    then a flood). The insert-trigger keeps vacuum and ANALYZE firing
    on every ~500-tuple burst of arrivals, which is what actually
    keeps planner statistics fresh and the heap dense.

    Verified 2026-05-12 on every ECA DB (wax-mainnet, wax-testnet,
    eos-mainnet, proton-mainnet, proton-testnet, jungle4-testnet) at
    dbinfo version 1.3.34: these reloptions are already applied
    out-of-band, heap is steady at < 64 KB, autovacuum_count is in
    the 40-50k range over the cluster pod lifetimes. This migration
    codifies that state so (a) the dbinfo version catches up and
    (b) greenfield chain deployments get the same tuning automatically.

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
  autovacuum_vacuum_scale_factor          = 0.05,
  autovacuum_vacuum_threshold             = 50,
  autovacuum_analyze_scale_factor         = 0.05,
  autovacuum_analyze_threshold            = 500,
  autovacuum_vacuum_insert_scale_factor   = 0.05,
  autovacuum_vacuum_insert_threshold      = 500
);

UPDATE dbinfo SET "value" = '1.3.35' WHERE name = 'version';
