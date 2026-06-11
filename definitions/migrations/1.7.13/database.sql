/*
  1.7.13 - Two-lane priority queue for the sales-filter drain + sliced bulk price refresh
  (see atomicmarket.sql for the function changes).

  PROBLEM
  The hourly refresh_atomicmarket_sales_filters_price() bulk-enqueues every variable_price
  listing (~235k rows on WAX mainnet) into atomicmarket_sales_filters_updates — the same
  strictly-FIFO (ORDER BY seq) queue that carries real-time trigger events. A user's
  cancel/relist enqueued right after the dump waits behind all of it at ~5-15k rows/min,
  so atomicmarket_sales_filters (the only source for /atomicmarket/v2/sales) runs minutes
  to tens of minutes stale for fresh user actions (measured: queue +235k every ~62 min,
  7-day median depth ~152k).

  FIX
  prio lanes: real-time trigger events enqueue at prio 0, the bulk price refresh at prio 1,
  and the drain claims ORDER BY prio, seq — user events are picked up by the very next
  batch regardless of bulk backlog. A real change upgrades an already-queued bulk row to
  prio 0; the bulk refresh never downgrades a pending real-time row (LEAST). Existing
  backlog rows default to prio 0, exactly preserving pre-upgrade FIFO order (one-time).

  prio is deliberately NOT indexed, like seq (1.7.11): the claim is a seqscan + top-N sort
  (ms against the ~36s recompute/COMMIT even at a 235k backlog, ~20k steady-state after
  slicing), and keeping both out of indexes keeps the hot ON CONFLICT seq/prio bumps HOT
  (fillfactor 70, 1.7.11). Escape hatch if monitoring disagrees: partial (prio, seq)
  indexes via a later atomicmarket-deferred.sql CREATE INDEX CONCURRENTLY.

  The non-volatile DEFAULT makes this ALTER metadata-only (no table rewrite, unlike the
  1.7.11 seq column whose nextval() default forced one).
*/

-- IF EXISTS: database.sql runs for every deployment, with or without the
-- atomicmarket handler; installs without the queue table must still advance
-- the dbinfo version (their atomicmarket.sql step is skipped entirely).
ALTER TABLE IF EXISTS atomicmarket_sales_filters_updates
    ADD COLUMN IF NOT EXISTS prio SMALLINT NOT NULL DEFAULT 0;

UPDATE dbinfo SET "value" = '1.7.13' WHERE name = 'version';
