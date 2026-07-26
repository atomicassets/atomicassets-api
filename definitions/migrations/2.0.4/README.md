# ECA 2.0.4: asset_id cardinality overrides on the market junction tables

Pins `n_distinct` on `atomicmarket_buyoffers_assets.asset_id` and
`atomicmarket_auctions_assets.asset_id`, and lowers the ANALYZE throttle on the
former so its statistics can refresh on their own.

## Why

Buyoffer requests carrying a template or asset filter resolve that filter with a
sequential scan of the entire `atomicmarket_buyoffers_assets` table. The junction
table is 10.6M rows on wax mainnet, and the scan runs once per request, to return
a handful of buyoffer ids.

The cause is a sampling failure, not a missing index. The index the better plan
needs, `atomicmarket_buyoffers_assets_asset_id`, already exists. Postgres
estimated 69,195 distinct `asset_id` values where there are 1,468,586, so it
expected 154 junction rows per asset against a true 7.26 and priced the nested
loop about 21x above its real cost. The parallel sequential scan won on cost and
lost badly on wall clock.

Measured on the production replica, one representative template filter:

| plan | time | buffers |
| --- | --- | --- |
| sequential scan, as production runs it | 2,046 ms | 110,132 |
| nested loop, forced with `enable_hashjoin=off` | 52 ms | 4,854 |

Over a ten-day window the table absorbed 142,821 sequential scans and 1.18
trillion row reads, and the endpoint's own numbers were 111,275 calls at a 4.03s
mean and a 271s maximum. It was the largest single consumer of execution time
among the market listing queries.

A negative `n_distinct` is a ratio of distinct values to live rows rather than an
absolute count, so it keeps rescaling as the table grows.

## Scope and reversal

`atomicmarket_auctions_assets` carries the same 8x underestimate but almost no
sequential-scan traffic, so its override is preventive rather than a fix for
observed harm.

Both overrides are catalog-only. Neither rewrites a table, builds an index, nor
takes a lock beyond the moment of the `ALTER`. `RESET (n_distinct)` on either
column restores sampled estimation.

The ratios are measured on wax mainnet, which holds the overwhelming majority of
the data. Other chains have different offer-to-asset ratios and will not match
exactly; they will still land within a small factor of the truth instead of the
21x the sampler produced.

## Verification

The estimate correction is arithmetic rather than measured: no environment
outside production carries a dataset where the planner makes this choice, so the
plan flip is predicted from the corrected rows-per-probe figure and confirmed by
the forced-nested-loop measurement above, not observed under the new statistics.
After the migration runs, re-run `EXPLAIN (ANALYZE, BUFFERS)` on a
template-filtered buyoffer listing and confirm it selects the nested loop over
`atomicmarket_buyoffers_assets_asset_id`, and that `seq_scan` on the table stops
climbing in `pg_stat_user_tables`.
