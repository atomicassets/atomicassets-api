# Changelog

Notable changes to atomicassets-api. This file starts at 1.7.17; the full
release history before that lives in
[GitHub Releases](https://github.com/atomicassets/atomicassets-api/releases).

Entry headings keep the `## [X.Y.Z] - YYYY-MM-DD` form. Each entry opens with a
summary line, then carries the sections that `RELEASING.md` on `main` defines,
in that order; the entry is the editorial text of the version's GitHub Release.
This branch carries the 1.7 maintenance line; the 2.x line lives in
`CHANGELOG.md` on `main`. This project follows semantic versioning.

## [1.7.27] - 2026-08-04

Maintenance release on the `release/1.7` branch (no v2 code), replacing the full template-price recompute with an incremental drain.

### Breaking changes

- `ATOMICMARKET_TEMPLATE_PRICES_INTERVAL_S` is removed, since the full recompute it paced no longer exists. The three drain variables under Upgrading replace it. (#159)

### Upgrading

- Image `ghcr.io/atomicassets/atomicassets-api:1.7.27`. The `1.7` tag moves to it, and this line no longer publishes `latest`. No repair or replay is needed. (#162)
- The filler applies `1.7.26` and `1.7.27` on boot. `1.7.26` adds `atomicmarket_template_prices_updates`, a deduplicating queue keyed by template and row kind, with triggers on `atomicmarket_stats_markets` and `atomicmarket_sales_filters_listed` feeding it, and replaces the function with `update_atomicmarket_template_prices(batch_size INT DEFAULT 200)`. `1.7.27` seeds the queue once at cutover. (#159)
- The split across two versions is load-bearing. `1.7.26`'s `DROP TRIGGER` statements take `ACCESS EXCLUSIVE` on the tables behind the market API's stats and `/v2/sales` reads, and the runner holds every lock a version takes until that version commits, so a seed sharing that transaction would park every API read behind those locks for its whole scan. Measured on WAX mainnet at 315,134 priced templates, `1.7.26` committed in 14 milliseconds and `1.7.27`'s seed ran 16.6 seconds holding nothing heavier than `ACCESS SHARE`. (#159)
- The cutover seed put 314,734 rows in the queue and took roughly forty minutes to drain, with the reader at head for all of it. Expect the due-count gauge to sit high for that window on a large deployment, because it is the seed clearing rather than a stall. Smaller deployments finish in seconds. (#159)
- `ATOMICMARKET_TEMPLATE_PRICES_DRAIN_INTERVAL_S` (60), `ATOMICMARKET_TEMPLATE_PRICES_BATCH_SIZE` (200) and `ATOMICMARKET_TEMPLATE_PRICES_DRAIN_BUDGET_MS` (55000) are new. (#159)
- `update_atomicmarket_template_prices()` keeps a zero-argument call, so an image rolled back to the full recompute still resolves against the new function body and drains correctly. (#159)

### Features

- Two gauges expose the queue: `eos_contract_api_template_prices_updates_pending_count`, split by priority lane and row kind, and `eos_contract_api_template_prices_updates_due_count`, the rows the next claim would actually take. Alert on the due count rather than the pending total, because a healthy queue holds one armed aging row per active template indefinitely by design; on WAX mainnet at steady state the pending total sits above eleven thousand while the due count sits near zero. Pair whichever you scrape with an `absent()` rule, since the collector swallows its errors at debug level and a vanished series has to read as unobserved rather than as an empty queue. (#159)

### Bug fixes

- The release workflow on this branch no longer publishes the `latest` Docker tag. `latest` follows the current major, which is the 2.x line, and the gate here fired on exactly the `v`-prefixed tags this branch produces, so each maintenance release reclaimed the tag and pointed unpinned consumers back a major. (#162)

### Other changes

- `update_atomicmarket_template_prices()` recomputes incrementally from the trigger-fed queue instead of rebuilding every priceable template on each run. The full recompute is a single uninterruptible statement on the filler's one long-running connection, so every run stalls block processing for its whole duration: on WAX mainnet that measured 129.0 seconds mean across 3,862 calls, with a worst case of 532 seconds and 138 hours of cumulative database time, while the reader logged `No blocks processed` and then raced back to head. Measured on the same database after upgrading, across 1,580 batches, the mean is 0.318 seconds and the worst case 4.142 seconds, with no `No blocks processed` bands in the twenty-five minutes following the cutover and the reader at head throughout. (#159)
- A template with resolved sales or live listings enqueues at real-time priority, and each template the drain processes arms a single future row covering both three-day windows, so aging prices refresh on their own boundary rather than through a full rescan. (#159)
- The 1.7 changelog entries carry release dates, so released versions no longer read as unreleased. (#157)

## [1.7.25] - 2026-07-27

Maintenance release on the `release/1.7` branch (no v2 code), adding an opt-in partition-parallel drain for large sales-filter backlogs.

### Upgrading

- Image `ghcr.io/atomicassets/atomicassets-api:1.7.25`, and the `1.7` tag moves to it. No repair or replay is needed. (#154)
- Migration `1.7.25` adds two functions and one index. It creates no tables and rewrites no data. On a large deployment, build the index per-partition `CONCURRENTLY` under the same names first, and the migration's `CREATE INDEX IF NOT EXISTS` then attaches without rebuilding; the migration header carries the recipe. (#154)
- Nothing changes unless an operator launches the runner. The functions are inert until then, workers take the drain's global advisory key `SHARED` where the stock drain takes it exclusively, so the two never work the queue at once, and workers never claim asset rows, which fan out to arbitrary sales and are not partitionable. Every claim, recompute and release is one transaction with an xact-scoped lock, so nothing is orphaned by a crash. (#154)
- One behavior to know before running it: the partition claim orders by `seq` alone while the stock drain orders by `prio, seq`, because the two-lane priority queue arrived in `1.7.13`, after this drain was designed. Output is unaffected, since the recompute is identical and any path that sets `prio` also bumps `seq`, so the release guard still declines to delete a row re-enqueued mid-batch. While workers are running, real-time enqueues do not jump the backlog. (#154)

### Features

- `update_atomicmarket_sales_filters_partition(part_count, part_index, batch_size)` is the stock recompute restricted to `sale_id % part_count = part_index`. Run one worker per index. (#154)
- `normalize_atomicmarket_sales_filters_offers(batch_size)` converts queued offer rows into the equivalent queued sale rows so partition workers can own them, and a new index on `atomicmarket_sales_filters (assets_contract, offer_id)` also speeds the stock drain's offer resolution. (#154)
- `node build/bin/drain-sales-filters.js [--partitions N] [--batch B] [--skip-offers]` runs the workers and analyses the churned tables afterwards. Measured on WAX mainnet, 8 workers cleared 3,276,752 queued sales in 229 seconds with the reader at head throughout. (#154)

### Other changes

- The stock drain is deliberately single-flight, because concurrent unpartitioned drains could recompute the same sale from two backends and deadlock, so `1.7.11` put an advisory lock in front of it. That leaves no recovery path that uses the hardware, and a backlog left by a deep catchup or an extended outage clears at single-connection random-read speed while `/v2/sales` filters go stale: a WAX backlog of 24.9M rows was measured draining at roughly 17 rows per second. The recompute parallelises cleanly across disjoint sales, which hash-partitioning the queue provides. (#154)

## [1.7.24] - 2026-07-26

Corrects the cardinality estimate that sent buyoffer listings filtered by template or asset into sequential scans.

### Upgrading

- Which plan the corrected statistics actually produce is a planner decision on the deployed dataset, so confirm it after upgrading. `definitions/migrations/1.7.24/README.md` records the check. (#143)

### Bug fixes

- Migration `1.7.24` pins `n_distinct` on `atomicmarket_buyoffers_assets.asset_id` and `atomicmarket_auctions_assets.asset_id`. Postgres sampled 69,195 distinct values on WAX mainnet against 1,468,586 actual, so it expected 154 junction rows per asset instead of 7 and priced the nested loop over the existing `asset_id` index about 21x above its true cost. On a production replica that nested loop, when forced, runs in 52 ms against 4,854 buffers where the sequential plan takes 2,046 ms and 110,132 buffers. (#143)

## [1.7.19] - 2026-07-15

Stops the template-price recompute retrying forever after a cache-evicting restart, and makes the filler crash rather than idle when its reader dies.

### Upgrading

- `ATOMICMARKET_TEMPLATE_PRICES_STATEMENT_TIMEOUT_S` is new, default 900s. It tunes the per-transaction `statement_timeout` the template-price recompute now sets for itself. (#94)

### Features

- `GET /health` reports the configured chain id alongside the chain status. Consumers pointing an instance at the wrong chain previously found out only through the `/alive` success string, because `/health` carried no chain identity at all. (#104)

### Bug fixes

- Mint rows are skipped rather than rejected when a replay re-inserts them. After a crash that commits data past the reader checkpoint, replay re-inserts identical rows into `atomicassets_mints` and the unique `(contract, asset_id)` index rejects them; the `23505` is classed transient, but the retry path reuses the aborted transaction's released client, so every restart died on the same block and the filler wedged permanently. Mints are immutable facts and the sibling assets insert already upserts, so conflicts on replay carry no information and are skipped with `ON CONFLICT DO NOTHING`. (#102)
- The `update_atomicmarket_template_prices()` recompute raises its own per-transaction `statement_timeout` via `SET LOCAL`. A cold full recompute against an empty or evicted cache takes 7-8 minutes, longer than the maintenance pool's own 5-minute connection-level `statement_timeout`, so without a per-transaction override the job would time out and retry on every interval indefinitely after any cache-evicting restart. (#94)
- The filler's `unhandledRejection` and `uncaughtException` handlers log and `process.exit(1)` instead of swallowing the error and staying up. A swallowed startup rejection, for example a `statement_timeout` during `AtomicAssetsHandler.init`'s mint-gap check on a cold cache, left the process alive but the reader never started, and Kubernetes had no crashed process to restart, so the filler fell behind at chain rate with no liveness signal. The API server keeps its separate handlers unchanged, since a single stray rejection there should not take the whole API down. (#96)
- The primary process exits on an unexpected reader-worker death. Each forked worker owns one reader config, and a worker killed by its own `unhandledRejection` or `uncaughtException` handler exits without the `failure` message the primary otherwise relies on, so the primary used to keep running with a dead reader and a still-passing `/health`. A normal SIGTERM shutdown is exempted so it still exits cleanly instead of through this escalation path. (#96)

## [1.7.18] - 2026-07-09

Maintenance release on the `release/1.7` branch (no v2 code), keeping a 1.x filler alive on a chain running AtomicAssets v2 contracts.

### Upgrading

- Image `ghcr.io/atomicassets/atomicassets-api:1.7.18`, and the `1.7` tag moves to it. If your filler is already crash-looping on the error below, swap the image and restart: it replays from its checkpoint and moves past the block. Nothing in the database needs repair. (#90)
- This release keeps a v1 indexer running against a chain on AtomicAssets v2 contracts, but it does not index the new v2 data (mutable templates, schema media types, author succession, royalty configuration). That requires the 2.0 line. (#90)

### Bug fixes

- AtomicAssets v2 contracts add a `deltemplate` action that deletes rows from the on-chain `templates` table, which was impossible when the 1.x handler was written. Fillers up to 1.7.17 treat that delta as a fatal error and crash-loop on the same block after every restart, logging `Consumer queue stopped due to an error at #<block> AtomicAssets: A template was deleted. Should not be possible by contract`. The filler now logs a warning and keeps the indexed template row instead of deleting it, because `atomicassets_assets` references templates with `ON DELETE RESTRICT` and the contract only allows deleting templates that never issued an asset, so the retained row stays accurate. (#90)

### Other changes

- CI checks run on `release/**` maintenance branches. (#90)

## [1.7.17] - 2026-06-21

Operator-focused release for self-hosting the 1.x line, converting the atomicmarket seller and buyer indexes to btree.

### Upgrading

- Image `ghcr.io/atomicassets/atomicassets-api:1.7.17`, and the `1.7` tag moves to it. (#77)
- Migration `1.7.17` swaps the `seller` and `buyer` indexes on `atomicmarket_sales`, `atomicmarket_auctions`, `atomicmarket_buyoffers` and `atomicmarket_template_buyoffers` from hash to btree, online with `CREATE INDEX CONCURRENTLY` and with no downtime to the filler or API. Postgres cannot build a hash index with parallel workers and the build is slower, which made the `seller` index the long pole of a `pg_dump` restore on large chains. Btree serves the same equality lookups and restores far faster. (#77)
- The runtime config files load from `CONFIG_DIR`, default `/home/node/app/config`, so the container and existing deployments are unchanged. Set `CONFIG_DIR=./config` to run the binaries from a local checkout. (#77)

### Features

- `docker-compose.yml` brings up the full stack (Postgres, Valkey, schema init, filler and server) for a one-command local or self-host setup. (#77)
- The README gains an explicit `pnpm build` step and clearer ordering in the Quickstart, a "Restore from a published dump" section covering the download from `backups.atomichub.io` and a restore with `pg_restore --jobs` and a raised `maintenance_work_mem`, and a Troubleshooting section. (#77)

### Bug fixes

- The server process exits on a fatal startup failure instead of staying alive but not listening, so an orchestrator restarts it until the schema is ready. (#77)
- Migration `1.3.30` no longer runs `CREATE INDEX CONCURRENTLY` on the partitioned `atomicmarket_sales_filters` parent, which Postgres rejects. The statement always errored and was skipped, so a from-scratch install now migrates in one pass. (#77)
- The example config files are renamed from `*.config.json.template` to `*.config.example.json`, so the `cp` commands in the README work as written. (#77)

### Other changes

- `pnpm start:server`, `pnpm start:filler` and the `pnpm db:*` scripts build the project automatically when `./build` is missing, so a fresh clone no longer fails with `Cannot find module '.../build/bin/filler.js'`. The `db:schema:init` and `db:migrate:up` scripts standardise on the swc build (`pnpm build`) instead of a separate `tsc` invocation. (#77)

