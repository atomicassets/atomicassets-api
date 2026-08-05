# Upgrading to AtomicAssets v2

For self-hosted operators moving an existing indexer to the 2.x line, including
anyone still running the original `pinknetworkx/eosio-contract-api`.

## Before you start

**You do not need Postgres 18.** The v2 schema uses nothing newer than what
`eosio-contract-api` already required. See [Postgres](#postgres).

**Upgrade before the chain flips to the v2 contract, not after.** A v2 indexer
reads a still-v1 chain correctly and its new handlers stay dormant until the
contract changes on chain. A v2 filler that is subscribed when the flip happens
records it as it occurs, so no gap can open. Upgrading afterwards needs a
recovery step: see
[Upgrading after the contracts are already live](#upgrading-after-the-contracts-are-already-live).

**You do not hand-apply SQL.** Point the filler at the v2 image and it runs every
pending migration in order, from a 1.3.x schema through to the current 2.0.x.

**How long it takes depends entirely on the version you start from**, by orders
of magnitude. See [How long it takes](#how-long-it-takes) before choosing a
window.

If you are already crash-looping on `AtomicAssets: A template was deleted`, your
indexer predates 1.7.18 and has hit a v2 `deltemplate` on chain. Upgrading the
image recovers in place with no database repair. See
[Compatibility](#compatibility).

## What changes

The on-chain AtomicAssets v2 contract is an additive upgrade, so existing tables
keep their layout and existing clients are unaffected. The indexer gains support
for mutable templates, including template deletion and max-supply reduction;
schema media types; and collection author succession.

It also gains an AtomicMarket royalty read layer: raw mirrors of the AtomicMarket
v2 royalty config tables, and a per-recipient settled-payout ledger fed by the
`logroy*` settlement actions, served under `/atomicmarket/v1/royalties/*`.
Listing responses gain `current_collection_fee`, the collection's live
`market_fee`, while the stored `collection_fee` remains the listing-time
snapshot.

One caveat on royalties: the indexer records `logroy*` traces only from blocks it
processes while subscribed. Deploy this version before royalty configs go live on
a chain, or replay from the AtomicMarket v2 deployment block to capture earlier
settlements.

## Postgres

There is no Postgres 18 requirement. We run 18 internally by choice, not
constraint.

PostgreSQL 14 or newer is recommended. In practice the minimum is whatever you
already run: `eosio-contract-api` documented 13 or newer, and the v2 schema uses
nothing beyond those releases. CI and the bundled `docker-compose.yml` run
Postgres 16. If you are on 13 and want a supported line, a minor bump to 14 is
enough.

## Upgrade

1. Pull `ghcr.io/atomicassets/atomicassets-api:2.0`. In production, pin the exact
   patch you tested rather than the moving `2.0` tag. The README's
   [Releases](./README.md#releases) section records what each tag tracks.
2. Stop the filler. Leave the server running if you want to keep serving reads.
3. Start the filler on the v2 image. It runs all pending migrations before it
   begins reading.
4. Restart the server on the v2 image so it can serve the new fields and the
   `/atomicmarket/v1/royalties/*` endpoints.
5. Verify: `dbinfo` reports a 2.0.x version, the filler is advancing, and
   `GET /atomicmarket/v1/royalties/payouts` responds.

All of this can be done while the chain is still on the v1 contracts. The new
tables stay empty until the contracts are upgraded on chain.

## How long it takes

### From 1.7.x, seconds

None of the heavy index builds apply. `2.0.1`'s statement is
`CREATE INDEX IF NOT EXISTS` and the 1.7 line already created that index, so it
is a no-op. What remains is catalog-only DDL plus `2.0.7`'s one-time queue seed,
the only step that scales with your data, and it holds only `ACCESS SHARE` so
readers are unaffected while it runs.

Measured upgrading from `1.7.27`:

| Database size | Whole 2.0.0 to 2.0.7 chain |
| --- | --- |
| 2.2 TB | 18 seconds |
| 19 GB | under half a second |
| 2.5 GB | under half a second |

### From 1.3.x, hours

The chain rebuilds indexes on the largest tables in the schema. The heaviest are
`1.3.31`, which builds a B-tree over `contract_traces` from nothing because
`1.3.9` had dropped that table's primary key to reclaim disk; `1.3.34`, which
replaces that B-tree with a hash; and `2.0.1` on the partitioned
`atomicmarket_sales_filters`. On a mainnet-sized chain each is measured in hours.
For scale, `contract_traces` on WAX mainnet is roughly 2.14 billion rows across
about 750 GB.

That pair is also the disk spike. The B-tree runs about 81 GB and the hash that
replaces it 30 to 50 GB, and both exist at once during the changeover. Check free
space before starting.

### Timeouts and pre-building

Migrations run with `statement_timeout` disabled so a long build finishes rather
than being cancelled part way, while `lock_timeout` stays bounded so a migration
blocked behind another session fails rather than waiting indefinitely.
`MIGRATION_STATEMENT_TIMEOUT_MS` imposes a ceiling in milliseconds. Treat it as a
default rather than a guarantee: `1.6.4`, `1.7.11`, `1.7.12` and `2.0.1` each
disable the statement timeout for their own transaction, so no ceiling applies
while those run.

Several migrations carry a header describing how to pre-build their indexes
`CONCURRENTLY` ahead of the upgrade: `1.3.31`, `1.3.32`, `1.3.34`, `1.7.17` and
`2.0.1`. Doing so shortens the window in which the filler is down. It is an
optimisation, not a prerequisite. Some of those headers also claim the deferred
runner enforces a one-hour cap. It does not.

## Interrupting an upgrade

Each version's schema changes and its `dbinfo` bump commit together, so an
upgrade killed between versions resumes at the next one and repeats nothing.

Deferred SQL is the exception. `CREATE INDEX CONCURRENTLY` cannot run inside a
transaction, so those statements run after their own version has committed and
advanced `dbinfo`. A process killed during one leaves an invalid index behind,
and because `dbinfo` has moved past that version the runner never returns to it.
Restarting the filler will not rebuild the index, whatever the deferred files say
about re-runs being idempotent.

Recovery is manual. List the invalid indexes:

```sql
SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid;
```

Then drop each one and re-create it with the statement from that version's
`*-deferred.sql`. Prefer letting a deferred phase finish.

## Coming from `pinknetworkx/eosio-contract-api`

This project is the continued line of `eosio-contract-api`. The legacy repository
is archived; its final release, `v1.3.25`, adds the same `deltemplate` fix
described under [Compatibility](#compatibility) plus non-schema changes, so its
migration path is identical to a 1.3.24 deploy's.

The database lineage is shared, so there is no re-sync and no schema rewrite. The
migration runner walks your current `dbinfo` version forward through every
release in order, applying only the steps newer than what you have. To switch,
change your image to `ghcr.io/atomicassets/atomicassets-api:2.0` and start the
filler.

Notable steps an older deploy will cross:

- AtomicMarket seller and buyer indexes rebuilt from hash to btree (`1.7.17`).
  Sizable on a large mainnet but they run online.
- A one-time converge of the legacy `atomicassets_transfers` primary key
  (`1.7.12`).
- The v2 schema (`2.0.0`), the partition-parallel sales-filter drain (`2.0.1`),
  and the AtomicMarket royalty tables (`2.0.2`).
- The v2 continuity marker (`2.0.3`). If your chain has already switched to the
  v2 contracts and this reader carries a position from before the switch, a
  startup guard refuses to start. Read
  [Upgrading after the contracts are already live](#upgrading-after-the-contracts-are-already-live)
  first.
- Two catalog-only steps that rewrite no data: `n_distinct` overrides on the
  market junction tables (`2.0.4`) and a re-assert of the sliced price-refresh
  function signature (`2.0.5`), a no-op where your schema is already correct.

## Upgrading after the contracts are already live

A 1.x filler that ran across the on-chain flip to v2 missed something. It kept
indexing ownership, mints, transfers, offers and sales correctly, but it never
subscribed to the new v2 tables (`templates2`, `schematypes`, `authorswaps`), so
mutable template data, schema media types and pending author-succession changes
from that window are absent from your database.

A template deleted on chain during the gap is the worse case: `deltemplate` emits
no log action, so the row stays permanently stale and no replay can recover it,
however far back you rewind.

Because of this, the 2.0 filler refuses to start against a contract when all
three hold: the chain's `tokenconfigs` reports v2 or later, the reader already
has a stored position, and no v2-continuity marker exists for the contract. A
fresh sync is unaffected, since it proves the marker itself the moment its live
reader observes the flip. The guard's error names the recovery paths below.

Pick one, in order of data correctness.

**Restore a published dump.** Recommended. A database restored from
[backups.atomichub.io](https://backups.atomichub.io) was indexed by a 2.0 filler
that ran across the flip, so it carries none of the gap: deletion blocks are
exact, gap-period log rows are present, and the continuity marker is already set,
so the guard passes with no extra step. See
[Restore from a published dump](README.md#restore-from-a-published-dump).

**Run `reconcile`.** The fallback when a dump restore is not an option, such as
when no published dump exists for your chain, your reader config indexes
contracts the published database does not, or you cannot replace your database
wholesale.

Stop the filler and run `pnpm start:reconcile`, or `pnpm dev:reconcile` from a
checkout. It reads your `connections.config.json` and `readers.config.json`, and
refuses to run against a reader that is still live or was updated in the last 60
seconds. For each configured atomicassets contract it seeds current on-chain
state for `templates2`, `schematypes` and `authorswaps`, diffs on-chain
`templates` against your database to catch anything deleted during the gap, and
records the continuity marker. It is safe to re-run. Restart the filler when it
finishes.

Two skews are permanent and `reconcile` cannot fix them: templates deleted during
the gap are stamped at the reconcile run's snapshot block rather than their true
deletion block, and log and history rows from the gap stay missing.

**Rewind and replay.** The only path that recovers exact history rather than
current-state snapshots, including exact deletion timestamps. It requires a SHIP
node retaining history back to the v2 flip block. Rewind this reader's stored
position to at or before that block, set `accept_v2_gap: true` in its entry in
`readers.config.json`, and restart. The replay heals the missing v2 data by
re-processing the flip and everything after it. The override is needed only
because the guard cannot distinguish a deliberate rewind from an unhealed gap at
startup. This path is not automated.

**Accept the gap.** Set `accept_v2_gap: true` alone and restart. The filler
starts and records the marker at its current block without repairing anything.
Mutable-template, media-type and author-succession data from before that point
stays whatever it was, and any template deleted during the gap stays wrongly
listed as live. Reasonable only if that data does not matter to your deployment.

## Compatibility

A v2 indexer on a v1 chain is safe; the new handlers stay dormant.

A v1 indexer at 1.7.18 or later, or 1.3.25 of the legacy repository, keeps
running on a v2 chain. It indexes ownership, mints, transfers, offers and sales
as before and ignores the new v2 actions and tables. It will not carry
mutable-template, media-type, author-succession or royalty data until you upgrade
to 2.x.

A v1 indexer older than 1.7.18 on a v2 chain crashes the first time a template is
deleted on chain. AtomicAssets v2 adds `deltemplate`, and older fillers treat the
resulting table delta as fatal:

```
Consumer queue stopped due to an error at #<block> AtomicAssets: A template was deleted. Should not be possible by contract
```

It then hits the same block after every restart, producing a crash loop. Nothing
in the database is damaged. Upgrade the image to `1.7.18`, which stays on v1 and
is patched, or to `2.0` for full v2 data. Either replays from the last checkpoint
and moves past the block.

Operators can upgrade on their own schedule, but should move to at least the
patched v1 release before the chain they index switches to the v2 contract.

## Fresh install

If you are standing up a new indexer rather than upgrading, do not sync from
genesis. Start from `docker-compose.yml` and restore a published database dump
first. See [Restore from a published dump](README.md#restore-from-a-published-dump)
and [Keeping it running in production](README.md#keeping-it-running-in-production).

## Removing release-candidate leftovers

Applies only to databases that ran `2.0.0-rc1` through `2.0.0-rc3`. Those
candidates included a custodial-rental feature, an asset `holder` column and
`atomicassets_moves` tables, that was descoped before release. The migration
runner never revisits an applied version, so the rental schema survives the
upgrade.

No action is required. The leftovers are inert and later migrations apply cleanly
over them. The one visible residue is a stale `"holder"` field in asset API
responses, which comes from the outdated view definition rather than the objects
themselves.

To remove them, run the block below once from the repository root of your
checkout, as the role that owns the views. The `\i` paths are psql meta-commands
relative to that root. Pick a quiet window: the `DROP COLUMN` takes an
access-exclusive lock on `atomicassets_assets`, and the dropped views are
unavailable, until the transaction commits.

```sql
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

```
psql <your connection options> -X -v ON_ERROR_STOP=1 -f cleanup.sql
```

`atomicmarket_assets_master` is dropped first only because it selects from
`atomicassets_assets_master`, which cannot lose its `holder` output column in
place. The two `\i` lines re-create the views that must survive;
`atomicassets_moves_master` belongs to the removed rental schema and stays
dropped. Dropping the `holder` column also drops its index if you ran the
rc-era deferred index script.

Everything is guarded with `IF EXISTS` and wrapped in one transaction, and
`ON_ERROR_STOP` makes psql exit at the first error, so a partial run leaves no
half-state and the block is a no-op on a database that never ran an early
candidate. If you paste it into an interactive session instead, issue `ROLLBACK;`
yourself after any error, since an aborted transaction holds its locks until you
do.
