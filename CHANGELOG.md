# Changelog

Notable changes to atomicassets-api. This file starts at 1.7.17; the full
release history before that lives in
[GitHub Releases](https://github.com/atomicassets/atomicassets-api/releases).

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows semantic versioning.

## [2.0.0] - unreleased

AtomicAssets v2. See [UPGRADING.md](./UPGRADING.md) for the upgrade path,
including operators coming from `eosio-contract-api`.

### Added

- AtomicAssets v2 indexing and API: mutable templates, schema media types, and
  collection author succession. Migration `2.0.0` adds the schema, and `2.0.1`
  ports the partition-parallel sales-filter drain. (Custodial rentals - asset
  `holder`, `move` / `logmove`, and the `/atomicassets/v1/moves` endpoint -
  were descoped from the v2 release train and are not part of this release.)
- `types` on the schema endpoints, carrying the media-type descriptors authored
  through `setschematyp` exactly as stored. `format[].mediatype` merges those
  descriptors with a name/type heuristic, which suits a reader asking how to
  render a field but leaves an author unable to tell a stored value from a
  derived one. Since `setschematyp` replaces the whole descriptor array, a client
  working from the merged view alone writes the heuristic's guesses to chain on
  its first save. An empty array means the schema has no descriptors; the field
  is absent where a schema is nested inside another resource.
- `GET /openapi.json` serving the assembled OpenAPI 3.0 document as plain JSON,
  for code generation and tooling. The Swagger UI at `/docs` already embeds this
  document but did not expose it at a stable URL.
- Optional `cache_max_value_bytes` in `server.config` so operators can tune the
  response-cache size cap (default unchanged at 2 MB).
- `ecosystem.config.cjs` for PM2, and a README "Keeping it running in
  production" section covering docker-compose, PM2, and a systemd unit.
- `UPGRADING.md` with the v2 upgrade path and the Postgres-version answer (no
  PG18 required).
- AtomicMarket v2 royalty read layer. Migration `2.0.2` adds raw mirrors of the
  on-chain royalty config tables (`royaltyconf` / `royaltytemp` / `royaltyattr`)
  and an `atomicmarket_royalty_payouts` ledger fed by the settlement log actions
  (`logroyfound` / `logroytempl` / `logroyattr` / `logroydust`), with each
  payout row linked back to the sale / auction / buyoffer / template buyoffer it
  settled. New `/atomicmarket/v1/royalties/*` endpoints expose the config
  mirrors, the payout ledger (filterable by recipient, collection, listing,
  category, asset, and symbol), and per-account earnings aggregates. The four
  listing `/logs` endpoints include the royalty log actions, and every listing
  response gains `current_collection_fee`: the collection's live `market_fee`,
  since the v2 contract reads the fee at settlement and the stored
  `collection_fee` is only the listing-time snapshot.
- Gap detection for indexers upgraded after the on-chain v2 flip, plus a
  `reconcile` command to heal them. An indexer that ran the 1.x line across the
  upgrade keeps core indexing working but silently drops every `templates2`,
  `schematypes`, and `authorswaps` delta, and `deltemplate` emits no log action,
  so templates deleted during the gap leave stale rows that no trace replay can
  correct. Migration `2.0.3` adds a per-contract continuity marker, written when
  the config processor observes a v2 `tokenconfigs` delta, when `reconcile`
  completes, or when the operator sets `accept_v2_gap`. On a v2 chain with an
  existing reader position and no marker the filler refuses to start and names
  the recovery paths in order of data correctness. `reconcile` pages current
  chain state, reseeds the v2 tables, and stamps templates missing on chain as
  deleted at the snapshot block; it refuses to run against a reader that is not
  stopped, and its destructive branches abort when an enumeration returns empty
  against live rows.
- `chain_id` in the `chain` block of `GET /health`. Only the `/alive`
  plain-text response echoes the configured chain, so the structured endpoint
  that monitoring consumes carried no chain identity, leaving an instance
  pointed at the wrong chain with nothing to assert against.
- Author-swap participants in the `auswap` log metadata. `acceptauswap` and
  `rejectauswap` carry nothing but `collection_name` on chain, so a consumer of
  `contract_traces` could not tell who the prior author was, who the proposed
  author was, or who acted. `createauswap` now records `acceptance_date` when
  the block's `authorswaps` delta surfaces it, and accept and reject record
  `new_author`, `prior_author`, and `actor`. Fields that are not derivable are
  omitted.

### Changed

- The express cache "skipping SET" notice for oversized responses moved from
  warn to debug. It is expected for large responses (the body is still served,
  just not cached) and was flooding operator logs.
- The toolchain builds on pnpm 11. pnpm's own settings move from `.npmrc` to
  `pnpm-workspace.yaml` in camelCase, `onlyBuiltDependencies` becomes the
  `allowBuilds` map, and `.npmrc` keeps registry and network config. Version 11
  blocks exotic subdependencies and withholds freshly published releases by
  default.

### Fixed

- `sort=ending` on `/atomicmarket/v1/buyoffers` and
  `/atomicmarket/v1/template_buyoffers` returned a 500 instead of a 400. Both
  handlers accepted the value while neither had a sort column for it, so the
  lookup dereferenced undefined and threw. Neither listing type has an expiry to
  order by, and the endpoint documentation only ever offered `ending` for
  auctions, so the value is gone from both handlers and auctions is unchanged.
- Migration `2.0.4` pins `n_distinct` on `atomicmarket_buyoffers_assets.asset_id`
  and `atomicmarket_auctions_assets.asset_id`, correcting the cardinality
  estimate behind the sequential scans that buyoffer listings filtered by
  template or asset pay today. Postgres sampled 69,195 distinct values on wax
  mainnet against 1,468,586 actual, so it expected 154 junction rows per asset
  instead of 7 and priced the nested loop over the existing `asset_id` index
  about 21x above its true cost. On a production replica that nested loop, when
  forced, runs in 52ms against 4,854 buffers where the sequential plan takes
  2,046ms and 110,132. Which plan the corrected statistics actually produce is a
  planner decision on the deployed dataset, so operators should confirm it after
  upgrading; `definitions/migrations/2.0.4/README.md` records the check.
- The same migration lowers `autovacuum_analyze_threshold` on
  `atomicmarket_buyoffers_assets` from a million modifications to 100000, the
  throttle its sibling junction tables already use. Autoanalyze had never fired
  on the table, leaving every column's statistics frozen at the last manual run.
- The `update_atomicmarket_template_prices()` recompute now raises its own
  per-transaction `statement_timeout` via `SET LOCAL`, tunable through
  `ATOMICMARKET_TEMPLATE_PRICES_STATEMENT_TIMEOUT_S` (default 900s). A cold
  full recompute (empty/evicted cache) takes 7-8 minutes, longer than the
  maintenance pool's own 5-minute connection-level `statement_timeout`; without
  a per-transaction override the job would time out and retry on every
  interval indefinitely after any cache-evicting restart.
- The filler's `unhandledRejection` / `uncaughtException` handlers now log and
  `process.exit(1)` instead of swallowing the error and staying up. A
  swallowed startup rejection (e.g. a `statement_timeout` during
  `AtomicAssetsHandler.init`'s mint-gap check on a cold cache) left the
  process alive but the reader never started, and Kubernetes had no crashed
  process to restart - the filler fell behind at chain rate with no
  liveness signal. The API server keeps its separate handlers unchanged since
  a single stray rejection there should not take the whole API down. The
  primary process also now exits on an unexpected reader-worker death: each
  forked worker owns one reader config, and a worker killed by its own
  unhandledRejection/uncaughtException handler exits without the
  `failure`-message the primary otherwise relies on, so the primary used to
  keep running with a dead reader and a still-passing `/healthc`. A normal
  SIGTERM shutdown is exempted so it still exits cleanly instead of via this
  escalation path.
- Migrations no longer run under the runtime pool's statement timeout, which
  made upgrading a populated database impossible. That 30-second cap exists to
  cancel zombie API and filler queries, but the migration client came from the
  same pool, so every migration statement inherited it. Upgrading a 1.3.x
  database died at `1.3.31`, whose B-tree over `contract_traces` cannot be built
  in 30 seconds on any populated chain, and roughly thirty migrations on that
  path build indexes inside their transaction, so a larger chain failed even
  earlier. Migrations now run on their own connection with the statement timeout
  disabled and `lock_timeout` bounded at 60 seconds, and the deferred-SQL pool
  takes the same budget instead of a fixed hour. `MIGRATION_STATEMENT_TIMEOUT_MS`
  sets a ceiling in milliseconds for operators who want one. `UPGRADING.md`
  covers the durations, the disk this needs, and what an interrupted upgrade
  leaves behind.
- A database error during block processing stops the filler with the error that
  actually occurred. The block retry could never succeed: the traces and deltas
  are prepared once and consumed destructively, so a second attempt deserialized
  fields the first attempt had already replaced. It also re-entered with the
  transaction its own abort had returned to the pool, and that double release
  raised a pool error carrying no Postgres code, which read as fatal and stopped
  the consumer queue. Every duplicate key, deadlock, and serialization failure
  therefore became a crash loop reporting an unexplained release error instead of
  its cause. The retry is removed rather than repaired, since restarting from the
  durable `contract_readers` checkpoint performs the same replay with the whole
  in-memory state rebuilt. A transaction now finalizes exactly once, an aborted
  transaction is never reused, and an abort that fails while unwinding is logged
  without displacing the error it was unwinding.
- `/v2/sales` requests that combine a main collection filter with a price,
  created, or updated sort take the bounded GIN path. The sort column's btree
  streams in an order unrelated to the GIN predicate, so a sparse collection
  walked most of a partition before filling the `LIMIT`; on a production replica
  that shape ran to the statement timeout and its client retries sustained an IO
  brownout.
- Mint rows are skipped rather than rejected when a replay re-inserts them. A
  crash that commits block data past the reader checkpoint makes replay
  re-insert identical rows into `atomicassets_mints`, and the unique
  `(contract, asset_id)` index wedged the filler on that block permanently.
  Mints are immutable facts, so a replay conflict carries no information.
- The filler refuses a fork rollback below the reversible window instead of
  rewinding to it. A SHIP node restored from a stale snapshot serves a head far
  below the reader checkpoint, which the fork path would otherwise treat as a
  deep reorg and roll back to.
- The reader-worker fork uses a default `cluster` import, so `cluster.on` exists
  at runtime under the compiled build.
- `reconcile` treats a reader row that has been silent past the safety threshold
  as stopped even when its `live` flag survived. A filler that crashes or is
  deleted never clears that flag, and a filler refused by the v2 gap guard
  always dies uncleanly, so honoring a stale flag blocked the exact recovery the
  command exists for.

### Security

- The client-facing websocket transport runs on a patched `ws`. The socket.io
  transport terminates untrusted client connections and reached `ws` 8.18.3
  through `engine.io` and `socket.io-adapter`, exposing memory-exhaustion DoS
  from tiny fragments (CVE-2026-48779) and uninitialized memory disclosure
  (CVE-2026-45736). Updating both parents collapses every copy onto the patched
  release with no override left to unwind. `qs`, reachable through express and
  body-parser, is patched alongside.
- Build and test toolchain advisories are cleared in dev-only transitives that
  no shipped image runs. They cover archive extraction outside the target
  directory in `@xhmikosr/decompress` (CVE-2026-53486) and prototype-pollution
  RCE in `piscina` (CVE-2026-55388), both under `@swc/cli`'s binary downloader,
  plus CRLF injection in `form-data` via supertest and quadratic-complexity
  parsing in `js-yaml` via mocha.

## [1.7.18]

Maintenance release on the `release/1.7` branch; contains no v2 code.

### Fixed

- Survive AtomicAssets v2 contracts. The v2 contract adds a `deltemplate` action
  that deletes rows from the `templates` table, which was impossible when the
  1.x handler was written; the filler treated such a delta as a fatal error
  (`AtomicAssets: A template was deleted. Should not be possible by contract`)
  and crash-looped on the same block after every restart. The filler now logs a
  warning and keeps the indexed template row. The row is kept rather than
  deleted because `atomicassets_assets` references templates with
  `ON DELETE RESTRICT`, and the contract only allows deleting templates that
  never issued an asset, so the retained row stays accurate. 1.7.18 keeps
  running against a chain with v2 contracts but does not index the new v2 data -
  that requires 2.0.0.

## [1.7.17]

### Changed

- Convert the atomicmarket `seller` and `buyer` indexes on `atomicmarket_sales`,
  `atomicmarket_auctions`, `atomicmarket_buyoffers`, and
  `atomicmarket_template_buyoffers` from hash to btree. Postgres cannot build a
  hash index with parallel workers and the build is slower, which made the
  `seller` index the long pole of a `pg_dump` restore on large chains. Btree
  serves the same equality lookups and restores far faster. Migration `1.7.17`
  swaps them online with `CREATE INDEX CONCURRENTLY`, with no downtime to the
  filler or API.
- `pnpm start:server`, `pnpm start:filler`, and the `pnpm db:*` scripts now
  build the project automatically if `./build` is missing, so a fresh clone no
  longer fails with `Cannot find module '.../build/bin/filler.js'`.
- Standardise the `db:schema:init` and `db:migrate:up` scripts on the swc build
  (`pnpm build`) instead of a separate `tsc` invocation.
- Load the runtime config files from `CONFIG_DIR` (default `/home/node/app/config`,
  so the container and existing deployments are unchanged). Set
  `CONFIG_DIR=./config` to run the binaries from a local checkout.

### Added

- `docker-compose.yml` brings up the full stack (Postgres, Valkey, schema init,
  filler, and server) for one-command local and self-host setup.
- README: an explicit `pnpm build` step and clearer ordering in the Quickstart,
  a "Restore from a published dump" section (download from
  `backups.atomichub.io`, restore with `pg_restore --jobs` and a raised
  `maintenance_work_mem`), and a Troubleshooting section.

### Fixed

- Exit the server process on a fatal startup failure instead of staying alive
  but not listening, so an orchestrator restarts it until the schema is ready.
- Migration `1.3.30` no longer runs `CREATE INDEX CONCURRENTLY` on the
  partitioned `atomicmarket_sales_filters` parent, which Postgres rejects. The
  statement always errored and was skipped, so a from-scratch install now
  migrates in one pass.
- Rename the example config files from `*.config.json.template` to
  `*.config.example.json` so the `cp` commands in the README work as written.
