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

### Changed

- The express cache "skipping SET" notice for oversized responses moved from
  warn to debug. It is expected for large responses (the body is still served,
  just not cached) and was flooding operator logs.

## [1.7.18]

Maintenance release on the `release/1.7` branch; contains no v2 code.

### Fixed

- Survive AtomicAssets v2 contracts. The v2 contract adds a `deltemplate` action
  that deletes rows from the `templates` table, which was impossible when the
  1.x handler was written; the filler treated such a delta as a fatal error
  (`AtomicAssets: A template was deleted. Should not be possible by contract`)
  and crash-looped on the same block after every restart. The filler now logs a
  warning and keeps the indexed template row. 1.7.18 keeps running against a
  chain with v2 contracts but does not index the new v2 data - that requires
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
