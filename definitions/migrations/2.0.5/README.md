# ECA 2.0.5: re-assert the sliced price-refresh signature

Repairs databases where `refresh_atomicmarket_sales_filters_price` still has the
pre-1.7.13 no-argument signature, which makes the price refresh job fail on every
tick.

## Why

`1.7.13` changed the function from no arguments to `(slice, total_slices)`. A
signature change cannot be expressed as a plain `CREATE OR REPLACE`, so that file
drops the old overload and creates the new one. Where a database ends up carrying
only the no-argument form, the filler's job, which calls the sliced form, logs

```
function refresh_atomicmarket_sales_filters_price(unknown, unknown) does not exist
```

every interval, and the bulk price refresh never runs.

This was observed on one deployment where the other five functions defined by the
same `1.7.13` file were present and correct. Only the object whose signature moved
was stale, which is why re-running the whole file is not the remedy and a targeted,
idempotent re-assertion is.

## Scope

Both statements are no-ops on a correct schema. The `DROP` names the superseded
no-argument overload specifically, so it cannot remove the sliced one, and the
`CREATE OR REPLACE` rewrites a body identical to `1.7.13`'s. The definition is
copied from that migration unchanged.

Nothing else is touched: no tables, no data, no other functions.

## Verification

After the migration runs, the function should report the sliced signature and the
job should stop erroring:

```sql
SELECT pg_get_function_arguments(oid) FROM pg_proc
 WHERE proname = 'refresh_atomicmarket_sales_filters_price';
-- expect: slice integer DEFAULT 0, total_slices integer DEFAULT 1
```
