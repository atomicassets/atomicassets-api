# Changelog

Notable changes to atomicassets-api. This file starts at 1.7.17; the full
release history before that lives in
[GitHub Releases](https://github.com/atomicassets/atomicassets-api/releases).

Entry headings keep the `## [X.Y.Z] - YYYY-MM-DD` form. Each entry opens with a
summary line, then carries the sections that `RELEASING.md` defines, in that
order; the entry is the editorial text of the version's GitHub Release. The 1.7
maintenance line continues in `CHANGELOG.md` on the `release/1.7` branch. This
project follows semantic versioning.

## [2.2.1]

Bounds the socket notification payload the filler publishes. Lets the 1.7.11 migration run under a role that is not the owner of the sales-filter queue table.

### Upgrading

- Image `ghcr.io/atomicassets/atomicassets-api:2.2.1`. The `2.2` and `latest` tags move to it.
- No version directory is added, and the SQL of 1.7.11 itself changed. A database at 1.7.11 or later does no database work on boot.
- A database below 1.7.11 applies every pending version on its first boot on this image. [UPGRADING.md](./UPGRADING.md) gives the duration by starting version.
- The filler publishes socket notifications in a compact format that a server on an earlier version cannot read, so such a server drops every notification until it is upgraded, which is why API servers upgrade before fillers. A server on this version reads both the compact and the previous format, so it runs against a filler on either version. (#161)

### Bug fixes

- The filler serialized the whole transaction into every socket notification, so a transaction with many matching action traces reached the notification channel once per trace. A single block produced 31 MB of payload, and the WAX filler sent tens of gigabytes a day into a channel that can have no subscribers at all. A published message now carries each transaction it references once and points every notification at it by key. (#161)
- A reader that fell behind the chain head published its whole backlog of socket notifications, because the gate was a processing state that is set once and never reverts. Trace and delta notifications now go out only while the reader is within twice `db_group_blocks` of the head, the boundary at which it already commits one block at a time, and the ones collected further behind are discarded. Fork notifications are exempt, since a fork is the only rollback signal a socket client receives. (#161)
- A message on the notification channel that the API server cannot decode is logged and skipped rather than thrown out of the subscriber's message handler as an unhandled rejection. (#161)
- The 1.7.11 migration failed with `sequence must have same owner as table it is linked to` when the filler's connecting role, a superuser or a member of the owning role, was not itself the owner of `atomicmarket_sales_filters_updates`. Postgres compares the two owners by identity for `OWNED BY`, so a database created or restored under one role and migrated under another stopped at 1.7.5 on every boot. The migration now hands the new sequence to the table's owner before tying the two together. A role that cannot do that gets an error naming both roles. (#180)

### Other changes

- The filler's `/metrics` endpoint carries seven series for the notification publish path, each labelled by `filler_name` alongside `process` and `hostname`: `eos_contract_api_filler_notifications_published_total`, `eos_contract_api_filler_notification_transactions_published_total`, `eos_contract_api_filler_notification_bytes_published_total`, `eos_contract_api_filler_notification_publish_duration_seconds`, `eos_contract_api_filler_notification_batches_skipped_total`, `eos_contract_api_filler_notifications_skipped_total` and `eos_contract_api_filler_notification_publish_failures_total`. The reader runs in a forked worker, so the endpoint aggregates these over the cluster IPC, and a worker that does not answer within 5 seconds leaves the whole worker block out of that scrape. (#161)

## [2.2.0]

Moves the filler's SHIP reader onto a published package.

### Upgrading

- Image `ghcr.io/atomicassets/atomicassets-api:2.2.0`. The `2.2` and `latest` tags move to it.
- The migration set is unchanged from 2.0.0, so the filler performs no database work on boot.
- A heartbeat runs every 30 seconds and the socket is torn down after 300 seconds without a message or a pong. The previous client had neither and hung on a half-open connection. (#175)
- Reconnect backoff runs 5 seconds to 60 seconds instead of a fixed 5 second retry. (#175)
- A block, trace or delta payload the node serves empty escalates to a reconnect instead of pausing the queue permanently. Empty payloads at `block_num <= 1` only warn. (#175)
- A failure on the prepare path rejects into an unhandled rejection, which the filler turns into `process.exit(1)` and a supervisor restart. The previous client paused the queue until the stall watchdog fired. (#175)
- `ship_min_block_confirmation`, `ds_ship_threads`, `ship_prefetch_blocks`, `ship_ds_queue_size` and `ship_max_blocks_queue` keep their meaning. Heartbeat and idle timeout are not configurable in `readers.config.json`. (#175)

### Other changes

- The filler's SHIP reader is the `@atomichub/antelope-ship-utils` package (repository `atomicassets/antelope-ship-utils`) rather than an in-tree client. The in-tree reader, its deserializer worker and the direct `ws` and `node-worker-threads-pool` dependencies are gone, and the block-shape types are re-exported from the package. (#175)

## [2.1.0] - 2026-08-10

Splits the Redis pub/sub subscriber onto its own optional endpoint.

### Upgrading

- Image `ghcr.io/atomicassets/atomicassets-api:2.1.0`. The `2.1` and `latest` tags move to it. (#171)
- The migration set is unchanged from 2.0.0, so the filler performs no database work on boot. (#171)
- Five optional environment variables are new: `REDIS_SUB_HOST`, `REDIS_SUB_PORT`, `REDIS_SUB_USERNAME`, `REDIS_SUB_PASSWORD` and `REDIS_SUB_CONNECTION_TYPE`. Each falls back to its primary counterpart, and with `REDIS_SUB_HOST` unset both clients share one endpoint exactly as before. `104f817e`

### Features

- The pub/sub subscriber connection can point at a different Redis endpoint from the primary client. This keeps the rate limiter, response cache and health checking on a local instance while the subscriber reaches a remote one, so losing the remote endpoint costs live events rather than API health. `104f817e`

### Security

- `socket.io-parser` lifted past GHSA-2m8v-j782-fhvr. `3ca082d4`

### Other changes

- `README.md` records what each published image tag tracks. Exact version tags never move, the minor tags (`2.1`, `1.7`) follow the newest patch on their line, `latest` follows the newest stable release on the current major, and a prerelease moves neither the minor tag nor `latest`. (#158)
- `UPGRADING.md` states the upgrade duration by starting version and drops the deferred-upstream note. (#167)

## [2.0.0] - 2026-08-04

General availability of the 2.x line: AtomicAssets v2 indexing, the AtomicMarket v2 royalty read layer, and the filler and migration work that makes upgrading a populated database possible.

### Breaking changes

- `sort=ending` is gone from `/atomicmarket/v1/buyoffers` and `/atomicmarket/v1/template_buyoffers`. Both handlers accepted the value while neither had a sort column behind it, so it returned a 500 rather than a 400, and neither listing type has an expiry to order by. Auctions are unchanged. (#141)
- `ATOMICMARKET_TEMPLATE_PRICES_INTERVAL_S` is removed. The full recompute it paced no longer exists, and the four drain variables listed under Upgrading replace it. (#160)
- The filler exits on an unhandled rejection or uncaught exception, and the primary exits on an unexpected reader-worker death. It used to stay up with a dead reader and a passing health check, so expect a supervisor restart where a silent stall used to appear. Normal SIGTERM shutdown is exempt, and the API server keeps its own handlers so one stray rejection there cannot take the whole API down. (#106)
- On a v2 chain with an existing reader position and no continuity marker the filler refuses to start. This is deliberate. The recovery paths are under Upgrading. (#111)
- Custodial rentals are not in this release. The asset `holder` field, `move` and `logmove`, and `/atomicassets/v1/moves` were descoped from the v2 release train. (#84)

### Upgrading

- Image `ghcr.io/atomicassets/atomicassets-api:2.0.0`. The `2.0` and `latest` tags move to it. `latest` tracked the 1.7 line while 2.x was in release candidates and follows the current major from this release on, so pin an exact version in production. (#155)
- Upgrading before the chain switches to the v2 contract is safe: a v2 indexer reads a still-v1 chain and the new features stay dormant until the flip. The recommended order is the indexer first and the contract flip second, because a v2 filler subscribed for the flip records it as it happens and no gap can open. (#55)
- The filler applies these migrations in order on boot, and you do not hand-apply SQL. (#135)

| Migration | What it does |
| --- | --- |
| `2.0.0` | The AtomicAssets v2 schema. |
| `2.0.1` | Ports the partition-parallel sales-filter drain. |
| `2.0.2` | Royalty config mirrors and the payout ledger. |
| `2.0.3` | Per-contract continuity marker behind the v2 gap guard. |
| `2.0.4` | Pins `n_distinct` on `atomicmarket_buyoffers_assets.asset_id` and `atomicmarket_auctions_assets.asset_id`, then runs `ANALYZE`. Catalog only, and `RESET (n_distinct)` reverts either column. |
| `2.0.5` | Re-asserts the sliced signature of `refresh_atomicmarket_sales_filters_price`. |
| `2.0.6` | The template-price update queue, its triggers, and the batched drain. |
| `2.0.7` | Seeds the queue once at cutover, in a version of its own because `2.0.6` holds `ACCESS EXCLUSIVE` trigger locks until it commits. |

- From 1.3.x, budget hours. The chain rebuilds indexes on the largest tables in the schema: `1.3.31` builds a B-tree over `contract_traces` from nothing, since `1.3.9` had dropped that table's primary key to reclaim disk, `1.3.34` replaces that B-tree with a hash, and `2.0.1` creates an index over the partitioned sales filters. Each of those is measured in hours on a mainnet-sized chain, where `contract_traces` on WAX mainnet is roughly 2.14 billion rows across about 750 GB. (#135)
- From 1.7.x, expect seconds, because none of those index builds apply: `2.0.1`'s statement is `CREATE INDEX IF NOT EXISTS` and the 1.7 line already created that index, so what remains is catalog-only DDL plus `2.0.7`'s one-time queue seed, the only step that scales with your data. Upgrading a 2.2 TB WAX mainnet deployment from `1.7.27` ran the whole chain from `2.0.0` to `2.0.7` in 18 seconds, and a 2.5 GB chain took under half a second. The seed holds only `ACCESS SHARE`, so API readers are unaffected while it runs. (#160)
- Migrations no longer run under the runtime pool's 30 second statement timeout, which made upgrading a populated database impossible: a 1.3.x database died at `1.3.31`, and roughly thirty migrations on that path build indexes inside their transaction. They now run on their own connection with the statement timeout disabled and `lock_timeout` bounded at 60 seconds. `MIGRATION_STATEMENT_TIMEOUT_MS` sets a ceiling in milliseconds for operators who want one. (#135)
- `ATOMICMARKET_TEMPLATE_PRICES_DRAIN_INTERVAL_S` (60), `ATOMICMARKET_TEMPLATE_PRICES_BATCH_SIZE` (200) and `ATOMICMARKET_TEMPLATE_PRICES_DRAIN_BUDGET_MS` (55000) are new and replace the removed interval variable. (#160)
- `ATOMICMARKET_TEMPLATE_PRICES_STATEMENT_TIMEOUT_S` is new, default 900. (#94)
- `cache_max_value_bytes` in `server.config` is new and tunes the response-cache size cap, default unchanged at 2 MB. `ab14a208`
- If you already ran 1.x across an on-chain v2 flip, core indexing kept working but every `templates2`, `schematypes` and `authorswaps` delta was silently dropped, and `deltemplate` emits no log action, so templates deleted during the gap left stale rows that no trace replay can correct. The new `reconcile` command pages current chain state, reseeds the v2 tables, and stamps templates missing on chain as deleted at the snapshot block; it refuses to run against a reader that is not stopped, and its destructive branches abort when an enumeration returns empty against live rows. Migration `2.0.3` writes the continuity marker when the config processor observes a v2 `tokenconfigs` delta, when `reconcile` completes, or when the operator sets `accept_v2_gap`. (#111)

### Features

- AtomicAssets v2 indexing and API: mutable templates (`atomicassets_templates.mutable_data`, `deleted_at_block` and `deleted_at_time`, populated from the contract `templates2` table via `createtempl2`, `settempldata` and `deltemplate`), schema media types (`atomicassets_schemas.types` from `setschematyp`), and collection author succession (`atomicassets_collections.new_author_name` and `new_author_date`). These surface on the existing asset, template, schema and collection endpoints. (#55)
- `types` on the schema endpoints carries the media-type descriptors authored through `setschematyp` exactly as stored. `format[].mediatype` merges those descriptors with a name and type heuristic, and since `setschematyp` replaces the whole descriptor array, a client working only from the merged view writes the heuristic's guesses to chain on its first save, so read `types` when you intend to write back. An empty array means the schema has no descriptors, and the field is absent where a schema is nested inside another resource. (#126)
- AtomicMarket v2 royalty read layer: raw mirrors of the on-chain royalty config tables (`royaltyconf`, `royaltytemp`, `royaltyattr`) and an `atomicmarket_royalty_payouts` ledger fed by the settlement log actions (`logroyfound`, `logroytempl`, `logroyattr`, `logroydust`), with each payout row linked back to the sale, auction, buyoffer or template buyoffer it settled. `/atomicmarket/v1/royalties/*` serves the config mirrors, the payout ledger filterable by recipient, collection, listing, category, asset and symbol, and per-account earnings aggregates. The four listing `/logs` endpoints include the royalty log actions. (#86)
- Every listing response gains `current_collection_fee`, the collection's live `market_fee`. The v2 contract reads the fee at settlement, so the stored `collection_fee` is a listing-time snapshot and is no longer sufficient alone. (#86)
- `GET /openapi.json` serves the assembled OpenAPI 3.0 document as plain JSON, for code generation and tooling. The Swagger UI at `/docs` already embedded the document but exposed no stable URL. (#89)
- `chain_id` in the `chain` block of `GET /health`. Only the `/alive` plain-text response echoed the configured chain, so the structured endpoint that monitoring consumes carried no chain identity, leaving an instance pointed at the wrong chain with nothing to assert against. (#103)
- Author-swap participants in the `auswap` log metadata. `acceptauswap` and `rejectauswap` carry nothing but `collection_name` on chain, so a consumer of `contract_traces` could not tell who the prior author was, who the proposed author was, or who acted. `createauswap` now records `acceptance_date` when the block's `authorswaps` delta surfaces it, accept and reject record `new_author`, `prior_author` and `actor`, and fields that are not derivable are omitted. (#129)

### Bug fixes

- A database error during block processing stops the filler with the error that actually occurred. The block retry could never succeed, because traces and deltas are prepared once and consumed destructively and it re-entered with the transaction its own abort had returned to the pool, so every duplicate key, deadlock and serialization failure became a crash loop reporting an unexplained release error instead of its cause. The retry is removed rather than repaired, since restarting from the durable `contract_readers` checkpoint performs the same replay. (#134)
- Mint rows are skipped rather than rejected when a replay re-inserts them. Mints are immutable facts, so a replay conflict carries no information, and the unique `(contract, asset_id)` index used to wedge the filler on that block permanently. (#105)
- The filler refuses a fork rollback below the reversible window instead of rewinding to it, so a SHIP node restored from a stale snapshot no longer reads as a deep reorg. (#110)
- The template-price recompute raises its own per-transaction `statement_timeout` via `SET LOCAL`. A cold full recompute against an evicted cache takes 7 to 8 minutes, longer than the maintenance pool's 5 minute connection-level timeout, so without the override the job timed out and retried on every interval indefinitely after any cache-evicting restart. (#94)
- `reconcile` treats a reader row silent past the safety threshold as stopped even when its `live` flag survived. A filler that crashes or is deleted never clears that flag, and a filler refused by the v2 gap guard always dies uncleanly, so honoring a stale flag blocked the recovery the command exists for. (#131)
- The reader-worker fork uses a default `cluster` import, so `cluster.on` exists at runtime under the compiled build. (#108)
- `/v2/sales` requests that combine a main collection filter with a price, created or updated sort take the bounded GIN path. The sort column's btree streams in an order unrelated to the GIN predicate, so a sparse collection walked most of a partition before filling the `LIMIT`; that shape ran to the statement timeout and its client retries sustained an IO brownout. Forcing the bounded path took a representative query from 377 ms to 5.3 ms and the production mean for that shape from roughly 1,633 ms to 149 ms. (#101)
- Migration `2.0.4` pins `n_distinct` on `atomicmarket_buyoffers_assets.asset_id` and `atomicmarket_auctions_assets.asset_id`, correcting the cardinality estimate that sent buyoffer listings filtered by template or asset into sequential scans. Postgres sampled 69,195 distinct values on WAX mainnet against 1,468,586 actual, so it expected 154 junction rows per asset instead of 7 and priced the nested loop over the existing `asset_id` index about 21x above its true cost; forced, that nested loop runs in 52 ms against 4,854 buffers where the sequential plan takes 2,046 ms and 110,132 buffers, and measured on production after the correction the query ran in 20.7 ms and 4,789 buffers. Which plan the corrected statistics produce is a planner decision on the deployed dataset, so confirm it after upgrading with the check in `definitions/migrations/2.0.4/README.md`. (#142)
- Migration `2.0.5` re-asserts the sliced signature of `refresh_atomicmarket_sales_filters_price`. `1.7.13` changed that function from no arguments to `(slice, total_slices)`, which a signature change forces to be a drop plus create rather than a `CREATE OR REPLACE`, and a database left carrying only the no-argument form failed every tick of the bulk price refresh with `function refresh_atomicmarket_sales_filters_price(unknown, unknown) does not exist`, so that refresh never ran and `atomicmarket_sales_filters` went progressively stale for variable-price listings. Both statements are no-ops where the schema is already correct. (#149)
- Buyoffer and template-buyoffer socket notifications fire. The filler published on singular channel names while the API subscribed to plural ones, and `templateBuyofferSockets` was never registered, so those subscribers had never received an event. REST was never affected. `035f8ce2`

### Security

- The client-facing websocket transport runs on a patched `ws`. The socket.io transport terminates untrusted client connections and reached `ws` 8.18.3 through `engine.io` and `socket.io-adapter`, exposing memory-exhaustion denial of service from tiny fragments (CVE-2026-48779) and uninitialized memory disclosure (CVE-2026-45736). `qs`, reachable through express and body-parser, is patched alongside. (#112)
- Build and test toolchain advisories are cleared in dev-only transitives that no shipped image runs: archive extraction outside the target directory in `@xhmikosr/decompress` (CVE-2026-53486) and prototype-pollution RCE in `piscina` (CVE-2026-55388), both under `@swc/cli`'s binary downloader, plus CRLF injection in `form-data` via supertest and quadratic-complexity parsing in `js-yaml` via mocha. (#113)
- The `brace-expansion` denial-of-service advisory reached through `minimatch` is cleared in the dev toolchain. (#132)

### Other changes

- `update_atomicmarket_template_prices()` recomputes incrementally from a trigger-fed queue instead of rebuilding every priceable template. The full recompute was one uninterruptible statement reaching roughly two minutes on WAX mainnet, running on the filler's single long-running connection, so every run stalled block processing for its duration and the reader logged `No blocks processed` before racing back to head. The batched drain yields to the reader-lag gate between batches, and the function keeps a zero-argument call, so an image rolled back to the full recompute still runs. (#160)
- Two gauges expose the queue: `eos_contract_api_template_prices_updates_pending_count` split by lane and row kind, and `eos_contract_api_template_prices_updates_due_count`, the claimable backlog and the one worth alerting on. A healthy queue holds one armed aging row per active template indefinitely, so the pending total is a population count rather than a backlog. (#160)
- The sort hint is retired from the market list handlers. Postgres's Incremental Sort already terminates early on those tables, and forcing the hint measured 15x to 223x slower with up to three orders of magnitude more buffers touched. The shared type now documents when the hint is correct: only where the filter recheck is expensive and unordered with respect to the sort key. (#141)
- The toolchain builds on pnpm 11. pnpm's own settings move from `.npmrc` to `pnpm-workspace.yaml` in camelCase, `onlyBuiltDependencies` becomes the `allowBuilds` map, and `.npmrc` keeps registry and network configuration. Version 11 blocks exotic subdependencies and withholds freshly published releases by default. (#114)
- The express cache "skipping SET" notice for oversized responses moved from warn to debug. It is expected for large responses, the body is still served, and it was flooding operator logs. `ab14a208`
- `ecosystem.config.cjs` for PM2, plus a README section covering docker-compose, PM2 and a systemd unit, and `UPGRADING.md` carrying the upgrade path and the Postgres-version answer (no PG18 required). `b9ab03bd`
- The frozen `atomicassets` library is replaced by `@atomichub/atomicassets`, and the table-delta types are sourced from the SDK so they match what the decoder returns. (#136)

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

