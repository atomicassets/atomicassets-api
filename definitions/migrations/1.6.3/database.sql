/*
  1.6.3 - Bound update_atomicmarket_sales_filters() per call so the filler
  keeps up with high NFT-mint/transfer events.

  Background:
    atomicmarket_sales_filters_updates is the work queue feeding
    update_atomicmarket_sales_filters(): the per-row trigger
    update_atomicmarket_sales_filters_by_asset (on atomicassets_assets)
    enqueues one row per asset change, plus sale_id / offer_id rows from
    the market handlers. update_atomicmarket_sales_filters() then drains
    the queue and recomputes the affected atomicmarket_sales_filters rows.

    During a mass-mint event (observed on WAX mainnet 2026-05-28, collection
    `rustveil` ~88% of the queue) the queue reached 13k-18k rows. The pre-1.6.3
    function drained the ENTIRE queue in one transaction (the three
    `DELETE FROM atomicmarket_sales_filters_updates WHERE <col> IS NOT NULL`
    statements had no LIMIT), so a single call ran ~106 s and held a long
    transaction that contended with the block reader's per-block writes on
    atomicmarket_sales_filters. The maintenance job is gated by
    Filler.isFallingBehind(200); once the reader slipped past 200 blocks the
    drain was skipped, the queue grew, the next allowed run was even bigger and
    more contentious, and the reader fell further behind - a doom-loop that
    periodically tripped the reader's no-progress watchdog (hard restart).

  Fix (see definitions/migrations/1.6.3/atomicmarket.sql):
    update_atomicmarket_sales_filters() takes a `batch_size INT DEFAULT 5000`
    and consumes at most batch_size of each queue row type (asset / sale /
    offer) per call, returning the number of queue rows CONSUMED so the caller
    can loop until the queue is drained. Each call is now a short transaction;
    the filler job (src/filler/handlers/atomicmarket/index.ts) calls it in a
    budgeted loop and no longer skips draining while catching up. The per-sale
    recompute logic is unchanged, so filter OUTPUT is identical to 1.6.2 - only
    the batching changes.

    A companion deferred migration (atomicmarket-deferred.sql) REINDEXes the
    three partial indexes on the queue to reclaim accumulated index bloat that
    slowed the `asset_ids &&` overlap scans.

  This database.sql only advances dbinfo.version so subsequent boots skip the
  migration loop; the proc + REINDEX live in the handler files.
*/

UPDATE dbinfo SET "value" = '1.6.3' WHERE name = 'version';
