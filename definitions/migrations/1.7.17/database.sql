/*
  1.7.17 - Convert the atomicmarket seller/buyer indexes from hash to btree.

  Background:
    atomicmarket_{sales,auctions,buyoffers,template_buyoffers}.seller and
    .buyer were indexed with `USING hash`. The API only ever filters these
    columns by equality (seller = $1 / buyer = $1), so btree serves the same
    queries, but hash indexes have two operational drawbacks that hurt
    operators restoring a pg_dump:

      - PostgreSQL cannot build a hash index with parallel workers
        (max_parallel_maintenance_workers only applies to btree), so on a
        large table the build is single-threaded.
      - Hash builds are slower per row than btree.

    On WAX mainnet atomicmarket_sales (tens of millions of rows) the
    `atomicmarket_sales_seller` hash index became the long pole of a restore,
    reported as "grinding for days". Converting to btree lets the restore use
    parallel index builds and finishes far faster, with no change to query
    plans for the existing equality lookups.

  This database.sql only advances dbinfo.version so subsequent boots skip the
  migration loop; the online index swap lives in atomicmarket-deferred.sql,
  which the runner executes outside the migration transaction (CREATE INDEX
  CONCURRENTLY cannot run inside a transaction).

  Large deployments: the deferred runner enforces a 1 hour statement_timeout
  per statement (src/filler/upgrade-db.ts). If any single index build is
  expected to exceed that, run the swap manually off-peak via psql (the SQL in
  atomicmarket-deferred.sql) and then set dbinfo.version to '1.7.17' before
  deploying this release, so the filler skips the migration. See the README
  "Restore from a published dump" section.
*/

UPDATE dbinfo SET "value" = '1.7.17' WHERE name = 'version';
