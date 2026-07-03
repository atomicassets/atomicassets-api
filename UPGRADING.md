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
  pending migration in order, all the way from a 1.3.x schema to 2.0.x.
- One manual step on large chains: backfill the new `holder` column in batches.
  See [Holder backfill](#holder-backfill).

## What v2 adds

The on-chain AtomicAssets v2 contract is an additive, non-breaking upgrade. The
indexer gains:

- **Dual ownership (rentals).** Assets now track a `holder` alongside the owner,
  populated from the new on-chain `move` / `logmove` actions.
- **Moves.** A new `/atomicassets/v1/moves` endpoint and `atomicassets_moves`
  tables.
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

This project is the continued line of `eosio-contract-api`. The database lineage
is shared, so there is no re-sync and no schema rewrite. The migration runner walks
your current `dbinfo` version forward through every release in order, for example
`1.3.24 -> 1.3.25 -> ... -> 1.7.x -> 2.0.0 -> 2.0.1`, applying only the steps newer
than what you have.

To switch, change your image from
`ghcr.io/pinknetworkx/eosio-contract-api` (or your local build) to
`ghcr.io/atomicassets/atomicassets-api:2.0` and start the filler. Notable steps an
older deploy will cross:

- atomicmarket seller/buyer indexes rebuilt from hash to btree (1.7.17). On a large
  mainnet these are sizable but run online; see the 1.7.17 migration notes.
- A one-time converge of the legacy `atomicassets_transfers` primary key (1.7.12).
- The v2 schema: `holder`, moves, mutable templates, and schema media types (2.0.0),
  then the partition-parallel sales-filter drain (2.0.1).

## Upgrade runbook (existing deploy)

1. Pull the image: `ghcr.io/atomicassets/atomicassets-api:2.0` (or pin
   `2.0.0-rc3` while testing the release candidate).
2. Stop the filler. Leave the server up if you want to keep serving reads.
3. Start the filler against the v2 image. It runs all pending migrations before
   it begins reading. On large chains the 1.7.x index rebuilds and the 2.0.0
   schema changes can take a while; let them finish.
4. Run the [holder backfill](#holder-backfill).
5. Restart the server on the v2 image so it can serve the new fields and the
   `/moves` endpoint.
6. Verify: `dbinfo` shows version `2.0.x`, the filler is advancing, and
   `GET /atomicassets/v1/moves` responds.

You can do all of this while the chain is still on the v1 contract. The v2 indexer
runs cleanly against a v1 chain; holder simply equals owner and no moves exist
until the contract is upgraded on-chain.

### Holder backfill

The 2.0.0 migration adds `atomicassets_assets.holder` as a nullable column
(instant). Existing rows stay `NULL` until backfilled to equal `owner`. On a large
mainnet (WAX is ~475M rows) do **not** run a single full-table `UPDATE`; it rewrites
the whole table in one transaction and busts the statement timeout. Run it in
batches during a low-traffic window. The exact recipe, including the batched loop,
is in [`definitions/migrations/2.0.0/README.md`](definitions/migrations/2.0.0/README.md).

Small chains (testnets, small mainnets) can run the simple form directly:

```sql
UPDATE atomicassets_assets SET holder = owner WHERE holder IS NULL;
```

## Fresh install

If you are standing up a new indexer rather than upgrading, do not sync from
genesis. Start from `docker-compose.yml` and restore a published database dump
first. See [Restore from a published dump](README.md#restore-from-a-published-dump)
and [Keeping it running in production](README.md#keeping-it-running-in-production).

## Compatibility, in short

- v2 indexer on a v1 chain: safe. New handlers stay dormant.
- v1 indexer on a v2 chain: keeps running. It indexes ownership, mints, transfers,
  offers, and sales as before, and ignores the new v2 actions and tables. It will
  not crash; it simply will not have holder, moves, mutable-template, or media-type
  data until you upgrade.

Because of this, operators can upgrade on their own schedule. There is no flag day.

## Known follow-ups

Two items from the upstream v2 work are intentionally deferred and tracked for a
later release, noted here so they are not a surprise:

- The sales-filter `nx` / `nb` (non-transferable / non-burnable) flags are left on
  the drain-hardened 1.6/1.7 function rather than the upstream rewrite.
- The collection `data` update-blacklist change is left at the current behavior.

Both are flagged in `definitions/migrations/2.0.0/README.md`.
