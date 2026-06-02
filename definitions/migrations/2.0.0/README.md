# ECA 2.0.0 — AtomicAssets v2 migration notes

## `holder` backfill (release blocker, run out-of-band)

`2.0.0/atomicassets.sql` adds `atomicassets_assets.holder` as a nullable column
(instant, metadata-only). Existing rows have `holder = NULL` until backfilled to
equal `owner`. Do **not** run a single full-table `UPDATE` — on WAX mainnet
`atomicassets_assets` is ~475M rows / ~211 GB and one statement would rewrite the
whole table inside a transaction and bust the cluster `statement_timeout`.

Run a batched backfill out-of-band (filler paused or during a low-traffic
window), e.g.:

```sql
-- repeat until 0 rows affected; tune the batch size to keep each statement well
-- under statement_timeout. Run as the atomicassets app user (owner), not postgres.
DO $$
DECLARE
    affected integer;
BEGIN
    LOOP
        UPDATE atomicassets_assets a
        SET holder = owner
        WHERE ctid IN (
            SELECT ctid FROM atomicassets_assets
            WHERE holder IS NULL AND owner IS NOT NULL
            LIMIT 50000
        );
        GET DIAGNOSTICS affected = ROW_COUNT;
        RAISE NOTICE 'backfilled % rows', affected;
        EXIT WHEN affected = 0;
        COMMIT;
    END LOOP;
END $$;
```

Smaller chains (testnet, small mainnets) can run the simple
`UPDATE atomicassets_assets SET holder = owner WHERE holder IS NULL;` directly.

## Deferred from the upstream OIG PR (handled separately / flagged for audit)

- `update_atomicmarket_sales_filters` `nx`/`nb` (non-transferable / non-burnable)
  filter flags — the upstream PR rewrote the whole function off an old base; not
  ported here to avoid regressing the 1.6/1.7 drain-hardened version. Tracked in
  the v2 audit as a follow-up to graft onto the current function.
- Collection `data` update-blacklist change — left at canonical behavior; flagged
  for audit (could regress collection-data indexing).
