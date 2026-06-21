/*
  1.6.4 - Deduplicate the atomicmarket_sales_filters_updates queue.

  The queue had no uniqueness: handler triggers INSERT a row on every
  asset/sale/offer change, so a single sale that is touched repeatedly (e.g. a
  mint storm that re-mints/transfers the assets backing many listings) enqueues
  the same (market_contract, sale_id) / (asset_contract, asset_id) key dozens of
  times. During the 2026-05-29 rustveil storm the queue reached 9.3M rows that
  deduplicated to only 258k distinct sale keys (~31x) - bloating the backlog and
  multiplying the drain's per-row work.

  Fix: make the three partial indexes UNIQUE so duplicate enqueues collapse at
  the source (the enqueue functions become ON CONFLICT DO NOTHING in
  atomicmarket.sql). The unique partial indexes still serve the drain's
  `WHERE <col> IS NOT NULL LIMIT n` dequeue scans, so they replace the old
  non-unique ones 1:1.

  This migration runs in the upgrade transaction; the queue is normally small
  (hundreds of rows), so the dedup DELETE + index rebuild is sub-second. If a
  backlog is present at upgrade time it still completes - the DELETE keeps one
  row per key (lowest ctid).
*/

-- Lift the migration pool's 30s statement_timeout (src/connections/postgres.ts)
-- for THIS upgrade transaction. The dedup + unique-index rebuild below are heavy
-- precisely when a backlog exists (the incident case), so a 30s cap could cancel
-- the upgrade before the indexes/functions install. SET LOCAL covers the whole
-- upgrade txn (database.sql + handler SQL share one client/txn in upgrade-db.ts)
-- and is pgbouncer-safe (the transaction pins the server backend). lock_timeout
-- bounds the only indefinite-wait risk; migrations run at filler boot before the
-- reader enqueues, so queue-table contention is normally nil.
SET LOCAL statement_timeout = 0;
SET LOCAL lock_timeout = '60s';

-- 1) Collapse existing duplicates so the UNIQUE indexes can be built.
DELETE FROM atomicmarket_sales_filters_updates u USING (
    SELECT market_contract, sale_id, min(ctid) AS keep
    FROM atomicmarket_sales_filters_updates
    WHERE sale_id IS NOT NULL
    GROUP BY market_contract, sale_id
) k
WHERE u.sale_id IS NOT NULL
    AND u.market_contract = k.market_contract AND u.sale_id = k.sale_id
    AND u.ctid <> k.keep;

DELETE FROM atomicmarket_sales_filters_updates u USING (
    SELECT asset_contract, asset_id, min(ctid) AS keep
    FROM atomicmarket_sales_filters_updates
    WHERE asset_id IS NOT NULL
    GROUP BY asset_contract, asset_id
) k
WHERE u.asset_id IS NOT NULL
    AND u.asset_contract = k.asset_contract AND u.asset_id = k.asset_id
    AND u.ctid <> k.keep;

DELETE FROM atomicmarket_sales_filters_updates u USING (
    SELECT asset_contract, offer_id, min(ctid) AS keep
    FROM atomicmarket_sales_filters_updates
    WHERE offer_id IS NOT NULL
    GROUP BY asset_contract, offer_id
) k
WHERE u.offer_id IS NOT NULL
    AND u.asset_contract = k.asset_contract AND u.offer_id = k.offer_id
    AND u.ctid <> k.keep;

-- 2) Replace the non-unique partial indexes with UNIQUE equivalents.
DROP INDEX IF EXISTS market_sales_updates_sale_id;
DROP INDEX IF EXISTS market_sales_updates_asset_id;
DROP INDEX IF EXISTS market_sales_updates_offer_id;

CREATE UNIQUE INDEX market_sales_updates_sale_id ON atomicmarket_sales_filters_updates (market_contract, sale_id) WHERE sale_id IS NOT NULL;
CREATE UNIQUE INDEX market_sales_updates_asset_id ON atomicmarket_sales_filters_updates (asset_contract, asset_id) WHERE asset_id IS NOT NULL;
CREATE UNIQUE INDEX market_sales_updates_offer_id ON atomicmarket_sales_filters_updates (asset_contract, offer_id) WHERE offer_id IS NOT NULL;

UPDATE dbinfo SET "value" = '1.6.4' WHERE name = 'version';
