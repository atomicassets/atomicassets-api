/*
  1.3.32 - Partial index on atomicassets_offers for active-offer lookup.

  The filler's offers.ts onCommit handler issues a "find related active offers
  for these transferred asset_ids" query on every block that touches assets in
  pending/invalid offers. Query shape (paraphrased):

    SELECT offer.offer_id, offer.state
    FROM atomicassets_offers offer
    WHERE offer.contract = $1
      AND offer.state IN (0, 1)                -- PENDING, INVALID
      AND (offer.contract, offer.offer_id) IN (
        SELECT asset.contract, asset.offer_id
        FROM atomicassets_offers_assets asset
        WHERE asset.asset_id = ANY ($2)
      );

  A "hot" asset can appear in thousands of historical offers, so the outer loop
  can probe tens of thousands of (contract, offer_id) pairs against
  atomicassets_offers. With only a single-column offer_id index available and
  state kept on the heap, every probe requires a heap fetch to check state.
  On cold cache (post snapshot restore or primary flip) the random I/O pattern
  saturates Cinder and busts the 30s filler statement_timeout (observed 2026-04-22
  with only 3 asset_ids in the failing query).

  State distribution on WAX mainnet atomicassets_offers (~181M rows):
    state 0 (PENDING):    2,758,279  (1.52%)
    state 1 (INVALID):      197,814  (0.11%)
    state 3 (ACCEPTED):  50,006,893  (27.56%)
    state 4 (CANCELLED):126,181,735  (69.55%)
    state 5 (DECLINED):   2,260,675  (1.25%)

  Only 1.63% of rows are in the active states the filter asks for. A partial
  index on the join keys restricted to state IN (0,1) is ~100-150 MB on WAX
  mainnet, fits entirely in buffer pool, and turns the outer-loop probe into
  an Index-Only Scan. Verified via EXPLAIN against the exact pathological
  3-asset case that triggered tonight's stalls.

  Run manually BEFORE this migration on large DBs to avoid blocking filler
  startup on upgradeDb:

    SET statement_timeout = 0;
    SET lock_timeout = 0;

    CREATE INDEX CONCURRENTLY IF NOT EXISTS
      atomicassets_offers_active_contract_offer_idx
      ON atomicassets_offers (contract, offer_id)
      WHERE state IN (0, 1);

    ANALYSE atomicassets_offers;

  The CONCURRENTLY variant above is the actual rollout path. The fallback
  below ensures the index exists on greenfield deployments that skip the
  manual step.
*/

CREATE INDEX IF NOT EXISTS
  atomicassets_offers_active_contract_offer_idx
  ON atomicassets_offers (contract, offer_id)
  WHERE state IN (0, 1);

ANALYSE atomicassets_offers;

UPDATE dbinfo SET "value" = '1.3.32' WHERE name = 'version';
