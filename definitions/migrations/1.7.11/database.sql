/*
  1.7.11 - Decouple the sales-filter drain's queue claim from its heavy GIN write.

  PROBLEM (confirmed live via pg_locks on WAX): update_atomicmarket_sales_filters()
  claimed its batch with `DELETE FROM atomicmarket_sales_filters_updates ... RETURNING`
  at the START of its one ~25s transaction, holding those queue-row locks until COMMIT.
  The block reader's `UPDATE atomicassets_assets` fires the enqueue trigger
  (`INSERT ... ON CONFLICT DO NOTHING`, 1.6.4) which SPECULATIVE-WAITS (transactionid
  ShareLock) on the drain's transaction for the whole batch -> the reader stalls ~25s
  every drain cycle ("No blocks processed").

  FIX (atomicmarket.sql): the drain now SELECTs (no lock) its batch, recomputes, and only
  DELETEs the claimed queue rows at the VERY END, guarded by a per-row `seq` version token
  so a row re-enqueued mid-batch (bumped seq) survives the end-DELETE and is reprocessed
  -- no lost updates. This requires:
    * a monotonic `seq` column on the queue (this file), and
    * the enqueue paths to `DO UPDATE SET seq = nextval(...)` instead of `DO NOTHING` so a
      re-enqueue of an already-queued key bumps its version (atomicmarket.sql).

  The whole drain stays ONE transaction (claim-SELECT + recompute + end-DELETE), so it is
  crash-safe with no recovery code: a crash rolls all three back, leaving the queue rows
  intact at their original seq to be reclaimed on restart.

  This migration runs in the upgrade transaction at filler boot (before the reader
  enqueues), so queue-table contention is nil. The ADD COLUMN ... DEFAULT nextval() forces
  a table rewrite that populates a distinct, increasing seq per existing row; the queue is
  bounded (1.6.4 dedup, normally hundreds-to-low-thousands of distinct rows) so it is fast.
  SET LOCAL lifts the migration pool's 30s statement_timeout for the (rare) backlog case,
  exactly as 1.6.4/database.sql does.
*/

SET LOCAL statement_timeout = 0;
SET LOCAL lock_timeout = '60s';

-- Monotonic version token. Gaps are fine (a conflicting INSERT still consumes a value).
CREATE SEQUENCE IF NOT EXISTS atomicmarket_sales_filters_updates_seq;

-- NOT NULL DEFAULT nextval() => volatile default => table rewrite populating a distinct
-- increasing seq for every existing backlog row. Deliberately NOT added to the three
-- UNIQUE partial indexes, so the enqueue ON CONFLICT inference clauses are unchanged.
ALTER TABLE atomicmarket_sales_filters_updates
    ADD COLUMN IF NOT EXISTS seq BIGINT NOT NULL DEFAULT nextval('atomicmarket_sales_filters_updates_seq');

-- Tie the sequence lifecycle to the column so it is dropped with the table/column
-- (no orphaned sequence on a future recreate). OWNED BY does not affect the DEFAULT.
ALTER SEQUENCE atomicmarket_sales_filters_updates_seq OWNED BY atomicmarket_sales_filters_updates.seq;

UPDATE dbinfo SET "value" = '1.7.11' WHERE name = 'version';
