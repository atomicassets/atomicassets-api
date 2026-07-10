# Upgrading to AtomicAssets v2

This guide is for self-host operators moving an existing indexer to the v2 line,
including anyone still running the original `pinknetworkx/eosio-contract-api`. It
covers what changes, whether you need a new Postgres, and the exact steps.

## TL;DR

- You do **not** need Postgres 18. PostgreSQL 14+ is recommended; the schema runs
  on what you already have if you came from `eosio-contract-api` (which required
  13+). No Postgres major upgrade is required to adopt v2.
- Upgrading is **safe to do now, before the chain switches to the v2 contract.** A
  v2 indexer reads a still-v1 chain fine; the new features stay dormant until the
  contract is upgraded on-chain, then light up on their own.
- You do not hand-apply SQL. Point the filler at the v2 image and it runs every
  pending migration in order, all the way from a 1.3.x schema to 2.0.x. There
  are no manual steps; the v2 migrations are metadata-only and run in seconds
  on any chain size.
- Already crash-looping on `AtomicAssets: A template was deleted`? Your indexer
  predates 1.7.18 and hit a v2 `deltemplate` on-chain. See
  [Compatibility, in short](#compatibility-in-short) - upgrading the image
  recovers in place, no database repair needed.

## What v2 adds

The on-chain AtomicAssets v2 contract is an additive, non-breaking upgrade. The
indexer gains:

- **Mutable templates.** Template `mutable_data`, plus deletion and max-supply
  reduction.
- **Schema media types.** Per-format media-type metadata.
- **Collection author succession.** Pending author changes.
- **AtomicMarket royalty read layer.** Raw mirrors of the AtomicMarket v2
  royalty config tables and a per-recipient settled-payout ledger fed by the
  `logroy*` settlement log actions, served under `/atomicmarket/v1/royalties/*`.
  Listing responses gain `current_collection_fee` (the collection's live
  `market_fee`); the stored `collection_fee` remains the listing-time snapshot.
  Note the indexer only records `logroy*` traces from blocks it processes while
  subscribed: deploy this version before royalty configs go live on a chain, or
  replay from the AtomicMarket v2 deployment block to capture earlier
  settlements.

Existing on-chain tables keep the same layout, so existing data and clients are
unaffected.

## Postgres version

There is no Postgres 18 requirement. We run 18 internally as a choice, not a
constraint.

- Recommended: PostgreSQL 14 or newer.
- Minimum in practice: whatever you already run. `eosio-contract-api` documented
  13+, and the v2 schema uses nothing newer than features available in those
  releases. CI and the bundled `docker-compose.yml` run Postgres 16.

If you are on Postgres 13 and want to move to a supported line, a minor bump to 14
or later is enough. You never need 18.

## Coming from `pinknetworkx/eosio-contract-api`

This project is the continued line of `eosio-contract-api`. The legacy repo is
archived; its final release, `v1.3.25`, adds the same deltemplate fix described
below plus non-schema changes (a template_buyoffer subquery fix, response
compression, the MIT relicense), so its migration path is identical to a 1.3.24
deploy's. The database lineage is shared, so there is no re-sync and no schema
rewrite. The migration runner walks your current `dbinfo` version forward
through every release in order, for example
`1.3.24 -> ... -> 1.7.17 -> 2.0.0 -> 2.0.1 -> 2.0.2`, applying only the steps
newer than what you have.

To switch, change your image from
`ghcr.io/pinknetworkx/eosio-contract-api` (or your local build) to
`ghcr.io/atomicassets/atomicassets-api:2.0` and start the filler. Notable steps an
older deploy will cross:

- atomicmarket seller/buyer indexes rebuilt from hash to btree (1.7.17). On a large
  mainnet these are sizable but run online; see the 1.7.17 migration notes.
- A one-time converge of the legacy `atomicassets_transfers` primary key (1.7.12).
- The v2 schema: mutable templates, schema media types, and author succession
  (2.0.0), the partition-parallel sales-filter drain (2.0.1), then the
  AtomicMarket royalty tables (2.0.2).

## Upgrade runbook (existing deploy)

1. Pull the image: `ghcr.io/atomicassets/atomicassets-api:2.0` (or pin the
   exact release-candidate tag while testing one).
2. Stop the filler. Leave the server up if you want to keep serving reads.
3. Start the filler against the v2 image. It runs all pending migrations before
   it begins reading. On large chains the 1.7.x index rebuilds can take a
   while; the 2.0.x steps are metadata-only and finish in seconds.
4. Restart the server on the v2 image so it can serve the new fields and the
   `/atomicmarket/v1/royalties/*` endpoints.
5. Verify: `dbinfo` shows version `2.0.x`, the filler is advancing, and
   `GET /atomicmarket/v1/royalties/payouts` responds.

You can do all of this while the chain is still on the v1 contracts. The v2
indexer runs cleanly against a v1 chain; the new tables stay empty until the
contracts are upgraded on-chain.

## Ran a 2.0.0 release candidate before rc4?

Release candidates `2.0.0-rc1` through `2.0.0-rc3` included a custodial-rental
feature (an asset `holder` column and `atomicassets_moves` tables) that was
descoped before release. `2.0.0-rc4` and later ship without it, and the `2.0.0`
migration no longer creates it - but the migration runner never revisits an
applied version, so a database that ran one of those early candidates keeps the
rental schema after upgrading.

No action is required. The leftover tables and column are inert: the filler
never touches them, and later migrations apply cleanly over them. The one
visible residue comes from the outdated view definition, not the objects
themselves: asset API responses keep a stale `"holder"` field until
`atomicassets_assets_master` is re-created.

To remove the leftovers, save the block below as `cleanup.sql` and run it once
from the repo root of the checkout you are on (the `\i` lines are psql
meta-commands with paths relative to that root), as the role that owns the
views:

```
psql <your connection options> -v ON_ERROR_STOP=1 -f cleanup.sql
```

Pick a quiet window: the `ALTER TABLE ... DROP COLUMN` takes an
access-exclusive lock on `atomicassets_assets`, and the dropped views are
unavailable, until the transaction commits.

```psql
BEGIN;
DROP VIEW IF EXISTS atomicmarket_assets_master;
DROP VIEW IF EXISTS atomicassets_assets_master;
DROP VIEW IF EXISTS atomicassets_moves_master;
DROP TABLE IF EXISTS atomicassets_moves_assets;
DROP TABLE IF EXISTS atomicassets_moves;
ALTER TABLE atomicassets_assets DROP COLUMN IF EXISTS holder;
\i definitions/views/atomicassets_assets_master.sql
\i definitions/views/atomicmarket_assets_master.sql
COMMIT;
```

Dropping the `holder` column also drops its index, if you ran the rc-era
deferred index script. The two `\i` lines re-create the two views that must
survive; `atomicassets_moves_master` is part of the removed rental schema and
stays dropped. `atomicmarket_assets_master` is dropped first only because it
selects from `atomicassets_assets_master`, which cannot lose its `holder`
output column in place. Everything is `IF EXISTS`-guarded and wrapped in one
transaction, and `ON_ERROR_STOP` makes psql exit at the first error, rolling
the open transaction back on disconnect - a partial run leaves no half-state,
and the whole block is a no-op on a database that never ran an early
candidate. (If you paste it into an interactive session instead, issue
`ROLLBACK;` yourself after any error - an aborted transaction otherwise holds
its locks until you do.)

## Fresh install

If you are standing up a new indexer rather than upgrading, do not sync from
genesis. Start from `docker-compose.yml` and restore a published database dump
first. See [Restore from a published dump](README.md#restore-from-a-published-dump)
and [Keeping it running in production](README.md#keeping-it-running-in-production).

## Compatibility, in short

- v2 indexer on a v1 chain: safe. New handlers stay dormant.
- v1 indexer at 1.7.18 or later (or 1.3.25 of the legacy repo) on a v2 chain:
  keeps running. It indexes ownership, mints, transfers, offers, and sales as
  before, and ignores the new v2 actions and tables. It will not have
  mutable-template, media-type, author-succession, or royalty data until you
  upgrade to 2.x.
- v1 indexer older than 1.7.18 on a v2 chain: **crashes the first time a template
  is deleted on-chain.** AtomicAssets v2 adds a `deltemplate` action; older
  fillers treat the resulting table delta as fatal and stop with

  ```
  Consumer queue stopped due to an error at #<block> AtomicAssets: A template was deleted. Should not be possible by contract
  ```

  then hit the same block again after every restart - a crash loop. Nothing in
  the database is damaged. To recover, upgrade the image to `1.7.18` (stays on
  v1, patched) or `2.0` (full v2 data); either replays from the last checkpoint
  and moves past the block.

Operators can upgrade on their own schedule, but move to at least the patched
v1 release before the chain you index switches to the v2 contract.

## Known follow-ups

Two items from the upstream v2 work are intentionally deferred and tracked for a
later release, noted here so they are not a surprise:

- The sales-filter `nx` / `nb` (non-transferable / non-burnable) flags are left on
  the drain-hardened 1.6/1.7 function rather than the upstream rewrite.
- The collection `data` update-blacklist change is left at the current behavior.

Both are flagged in `definitions/migrations/2.0.0/README.md`.
