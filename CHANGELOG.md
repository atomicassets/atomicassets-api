# Changelog

Notable changes to atomicassets-api. This file starts at 1.7.17; the full
release history before that lives in
[GitHub Releases](https://github.com/atomicassets/atomicassets-api/releases).

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows semantic versioning.

## [1.7.19] - unreleased

### Fixed

- The `update_atomicmarket_template_prices()` recompute now raises its own
  per-transaction `statement_timeout` via `SET LOCAL`, tunable through
  `ATOMICMARKET_TEMPLATE_PRICES_STATEMENT_TIMEOUT_S` (default 900s). A cold
  full recompute (empty/evicted cache) takes 7-8 minutes, longer than the
  maintenance pool's own 5-minute connection-level `statement_timeout`; without
  a per-transaction override the job would time out and retry on every
  interval indefinitely after any cache-evicting restart.

## [1.7.18]

### Fixed

- Survive AtomicAssets v2 contracts. The v2 contract adds a `deltemplate` action
  that deletes rows from the `templates` table, which was impossible when this
  handler was written; the filler treated such a delta as a fatal error
  (`AtomicAssets: A template was deleted. Should not be possible by contract`)
  and crash-looped on the same block after every restart. The filler now logs a
  warning and keeps the indexed template row (the contract only allows deleting
  templates with zero issued supply, so the retained row stays accurate; the row
  is kept rather than deleted because `atomicassets_assets` references templates
  with `ON DELETE RESTRICT`). Indexers on this release keep running against a
  chain with v2 contracts, but do not index the new v2 data (mutable templates,
  schema media types, author succession, royalty configuration) - that requires
  2.0.0.

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
