# atomicassets-api

An indexer and HTTP API for
[AtomicAssets](https://github.com/pinknetworkx/atomicassets-contract),
[AtomicMarket](https://github.com/pinknetworkx/atomicmarket-contract),
[AtomicTools](https://github.com/pinknetworkx/atomictools-contract), and
related on-chain contracts on Antelope (formerly EOSIO) chains.

This codebase is a continuation of `eosio-contract-api` originally built by
[Pink Network](https://pink.gg) and is now maintained by the AtomicAssets
community. See [NOTICE](./NOTICE) for the project's lineage.

> **AtomicAssets v2 support is released.** The 2.x line indexes and serves
> mutable templates, schema media types, collection author succession, and the
> AtomicMarket royalty read layer. Moving an existing indexer, including one still
> on the original `eosio-contract-api`? See [UPGRADING.md](./UPGRADING.md). Short
> version: no Postgres 18 needed, and you can upgrade before the chain switches to
> the v2 contract. The 1.7 line stays available for deploys that are not ready.

## What it does

- Subscribes to a State History Plugin (SHIP) endpoint and indexes blocks
  into PostgreSQL in real time.
- Exposes a REST API documented via OpenAPI / Swagger at `/docs` covering:
  AtomicAssets (NFTs, templates, schemas, collections), AtomicMarket
  (sales, auctions, buy offers), AtomicTools (link claims), and curated
  collection lists.
- Indexes AtomicHub-specific contracts when enabled in the reader config:
  AtomicPacks (`atomicpacksx` for pack templates, claims, and reveal results)
  and AtomicDrops (`atomicdropsx` for drop templates and claims). Enable per
  chain by adding the relevant entries to `readers.config.json`:

      { "handler": "atomicpacksx",
        "args": { "atomicpacksx_account": "atomicpacksx", "store_logs": true } }
      { "handler": "atomicdropsx",
        "args": { "atomicdropsx_account": "atomicdropsx", "store_logs": true } }
- Streams live updates via WebSockets (Socket.IO) for sales, transfers,
  and trades.
- Ships a Prometheus metrics endpoint for monitoring filler health.

## Supported chains

The service is chain-agnostic and works against any Antelope chain that has
the AtomicAssets contract suite deployed. The maintainers run it in
production against:

- WAX mainnet and testnet
- EOS mainnet
- Proton (XPR Network) mainnet and testnet

## Quickstart

You will need:

- Node.js 22 (see [`.nvmrc`](./.nvmrc))
- pnpm 10+ (`corepack enable` is enough)
- PostgreSQL 14+
- Redis or Valkey 7+
- A SHIP endpoint for the chain you want to index

**1. Clone, install, and build.**

```sh
git clone https://github.com/atomicassets/atomicassets-api.git
cd atomicassets-api
pnpm install
pnpm build          # compile TypeScript to ./build (required before the start scripts)
```

The `build` step is not optional: `pnpm start:filler` and `pnpm start:server`
run the compiled output in `./build`, which is not committed to the repo. (The
`pnpm start:*` and `pnpm db:*` scripts will build automatically if `./build` is
missing, but running `pnpm build` once up front makes the first run obvious.)

**2. Create the database** that `connections.config.json` points at (the schema
step below creates the tables, not the database itself):

```sh
createdb atomicassets   # or: psql -c 'CREATE DATABASE atomicassets;'
```

**3. Copy the example configs and edit them for your environment.** At minimum
set the Postgres credentials, the Redis/Valkey host, and the chain's RPC + SHIP
endpoints in `connections.config.json`.

```sh
cp config/connections.config.example.json config/connections.config.json
cp config/server.config.example.json     config/server.config.json
cp config/readers.config.example.json    config/readers.config.json
```

**4. Initialise the schema, then start the filler and server.** The filler
writes blocks into Postgres; the server reads from Postgres and answers the API.
They are independent processes, but the server needs the schema to exist first,
so run `db:schema:init` before either.

When running outside the container, point `CONFIG_DIR` at your `config/`
directory; otherwise the binaries look in the image's `/home/node/app/config`.

```sh
export CONFIG_DIR="$PWD/config"
pnpm db:schema:init
pnpm start:filler   # in one terminal: indexes blocks from SHIP into Postgres
pnpm start:server   # in another: serves the REST + WebSocket API
```

The API will be available on port 9000 by default with Swagger UI at
[http://localhost:9000/docs](http://localhost:9000/docs).

A fresh filler syncs from the chain's genesis (or the `start_block` in
`readers.config.json`), which can take a long time on mainnet. To skip the
initial sync, restore a published database dump first. See
[Restore from a published dump](#restore-from-a-published-dump).

### Docker

A standalone container image is published on every push to `main`:

```sh
docker pull ghcr.io/atomicassets/atomicassets-api:main
```

You can also build locally:

```sh
docker build -t atomicassets-api:local .
```

The image entrypoint runs the API server. The filler is a separate process; run
it from the same image with `command: node build/bin/filler.js`.

#### docker-compose

`docker-compose.yml` brings up the full stack (Postgres, Valkey, the filler,
and the server) sharing your `config/` directory:

```sh
cp config/connections.config.example.json config/connections.config.json
cp config/server.config.example.json     config/server.config.json
cp config/readers.config.example.json    config/readers.config.json
# point connections.config.json at the compose service names:
#   postgres host -> "postgres", redis host -> "valkey"
docker compose up -d
```

The server is published on port 9000. The filler and server share the
`config/` bind mount, so edit the configs on the host and restart the
services to pick up changes.

### Keeping it running in production

`pnpm start:filler` / `pnpm start:server` run in the foreground and stop when you
disconnect. For an always-on deployment, supervise both processes so they restart
on crash and after a reboot. Any of the following work; pick one.

**docker-compose (recommended).** The services above set `restart: unless-stopped`,
so `docker compose up -d` already gives you supervised, reboot-surviving filler and
server. Nothing else to configure.

**PM2.** A ready-made `ecosystem.config.cjs` is included (filler + server). Build
first, since PM2 runs `node build/...` directly and does not trigger the `prestart*`
hooks:

```sh
pnpm install && pnpm build
pnpm db:schema:init            # once, before the first start
pm2 start ecosystem.config.cjs
pm2 save && pm2 startup        # survive reboots
pm2 logs                       # follow both processes
```

Override `CONFIG_DIR`, `FILLER_MAX_MEMORY`, or `SERVER_MAX_MEMORY` by exporting
them before `pm2 start`.

**systemd.** One unit per process. Build once (`pnpm build`), then create
`/etc/systemd/system/atomicassets-filler.service`:

```ini
[Unit]
Description=atomicassets-api filler
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
Type=simple
User=atomicassets
WorkingDirectory=/opt/atomicassets-api
Environment=CONFIG_DIR=/opt/atomicassets-api/config
ExecStart=/usr/bin/node --enable-source-maps build/bin/filler.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Copy it to `atomicassets-server.service` with `ExecStart=… build/bin/server.js`,
then:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now atomicassets-filler atomicassets-server
journalctl -u atomicassets-filler -f
```

## Configuration

Three JSON files in `config/` drive runtime behaviour:

- `connections.config.json`: Postgres, Redis, RPC endpoints, SHIP endpoint.
- `readers.config.json`: which chains the filler will index, contract
  filters, start block, and dataset selection.
- `server.config.json`: HTTP server port, rate limits, CORS, cache
  policies, provider name and URL displayed in `/docs`.

See `config/*.example.json` for working starting values. They are examples
rather than a complete reference: `IReaderConfig` and its siblings in
`src/types/config.ts` carry keys the example files leave out, among them
`ship_max_blocks_queue`, `delete_data` and `list_polls`.

### Filler throughput

`readers.config.json` ships conservative values. A filler catching up from a
published dump or from a long outage needs larger ones. These keys decide the
ingestion rate; the table compares each shipped value with the one the WAX
mainnet deployment runs.

| Key | Example | WAX mainnet | What it controls |
| --- | --- | --- | --- |
| `db_group_blocks` | `10` | `500` | Blocks per database transaction. Grouping applies only to an irreversible block while the reader is at least twice this many blocks behind head. A reversible block commits on its own whatever the distance, and so does every block once the reader is inside that distance. |
| `ship_prefetch_blocks` | `50` | `1000` | Becomes SHIP's `max_messages_in_flight`. The node stops sending after this many unacknowledged blocks, so it caps how deep the pipeline runs. |
| `ship_min_block_confirmation` | `30` | `30` | Blocks the client accumulates before acknowledging them. Keep it at or below `ship_prefetch_blocks`. |
| `ship_ds_queue_size` | `20` | `20` | Blocks allowed between deserialization and the database stage. |
| `ds_ship_threads` | `4` | core count | Worker threads for SHIP-level deserialization. Zero or absent runs deserialization on the filler's own event loop. |

Never remove `ship_ds_queue_size`. An absent key leaves the semaphore without a
limit, every acquire parks forever, and the reader wedges before its first block.
The log shows `No blocks processed` every five seconds until the stall timeout
exits the process and the supervisor restarts it into the same wedge.

A larger `db_group_blocks` writes more WAL per transaction, so raise
`max_wal_size` with it or Postgres checkpoints often enough to cancel the gain.
Set `PGSSLMODE=disable` when the database is local, because the client defaults
to `prefer` and negotiates TLS on a loopback connection otherwise.

## Restore from a published dump

Syncing a chain from genesis takes a long time. To start from a recent snapshot
instead, restore a published PostgreSQL dump, then let the filler catch up the
remaining blocks from SHIP.

Browse **[backups.atomichub.io](https://backups.atomichub.io)** to pick a chain
and download the latest dump, or script it against the JSON index. Each dump is a
`pg_dump` **directory-format** archive bundled into one store-only tar
(`<database>.dir.tar`), downloaded through the site's `/download` endpoint.

```sh
BASE=https://backups.atomichub.io
CHAIN=wax-mainnet              # or wax-testnet, eos-mainnet, proton-mainnet, ...

# 1. Resolve the latest dump's download path, artifact name, and checksum.
read URL ART SHA < <(curl -fsSL "$BASE/api/backups.json" | python3 -c '
import sys, json
chain = "'"$CHAIN"'"
net = next(n for n in json.load(sys.stdin)["networks"] if n["network"]["chain"] == chain)
d = net["db"]["latest"]
print(d["url"], d["artifact"], d["sha256"])')

# 2. Download (a plain GET; supports resume) and verify the checksum.
curl -fSL -o "$ART" "$BASE$URL"
echo "$SHA  $ART" | sha256sum -c -

# 3. Unpack the bundle (the .dir files are already zstd-compressed).
tar -xf "$ART"                 # -> <database>.dir/  (a pg_dump directory archive)

# 4. Create the target database (see Quickstart step 2), matching the name in
#    connections.config.json.
createdb atomicassets

# 5. Restore. One job per core, and raise maintenance memory so index builds
#    run in parallel and finish quickly.
PGOPTIONS='-c maintenance_work_mem=2GB -c max_parallel_maintenance_workers=4' \
  pg_restore \
    --dbname=atomicassets \
    --no-owner --no-acl \
    --jobs="$(nproc)" \
    "${ART%.tar}"              # the unpacked <database>.dir directory
```

Notes:

- `--jobs` parallelises both the data load and the index builds. The atomicmarket
  `seller` / `buyer` indexes are btree (since 1.7.17), so they build in parallel;
  on a dump predating 1.7.17 those were hash indexes that build single-threaded
  and dominate restore time.
- `maintenance_work_mem` is the single biggest lever for index build speed. The
  default (64 MB) is far too low for these tables; 1 to 2 GB is reasonable on a
  host with several GB of RAM.
- After the restore, run `pnpm db:migrate:up` once to apply any schema
  migrations newer than the dump, then start the filler. It resumes from the
  last block in the dump and catches up to the chain head.

## Troubleshooting

**`Error: Cannot find module '.../build/bin/filler.js'`**. The project has not
been compiled. Run `pnpm build` (which emits `./build`), then retry
`pnpm start:filler`. `./build` is intentionally not committed.

**The server exits immediately on startup.** The schema has not been
initialised. Run `pnpm db:schema:init` against the database in
`connections.config.json` before starting the server, and make sure the
database itself exists (`createdb`).

**`cp: config/*.example.json: No such file or directory`**. Run the copy
commands from the repository root; the example files live in `config/`.

**`sequence must have same owner as table it is linked to` during `Upgrade to 1.7.11`**.
The filler connects as a role that is not the owner of
`atomicmarket_sales_filters_updates`, and the image predates 2.2.1. Compare the
table owner with `postgres.user` in `connections.config.json`:

```sql
SELECT pg_get_userbyid(relowner) AS table_owner
FROM pg_class WHERE oid = 'atomicmarket_sales_filters_updates'::regclass;
```

Either move to image 2.2.1 or later, or, as a superuser, create the sequence
under the table owner before the next start. The migration then adopts it:

```sql
CREATE SEQUENCE atomicmarket_sales_filters_updates_seq;
ALTER SEQUENCE atomicmarket_sales_filters_updates_seq OWNER TO <table_owner>;
```

**Index creation runs for hours during a dump restore.** See
[Restore from a published dump](#restore-from-a-published-dump). Restore with
`--jobs` and a raised `maintenance_work_mem`, and use a dump from 1.7.17 or
later (btree seller/buyer indexes).

**The filler exits at `COMMIT` with `23503` on
`atomicassets_assets_schemas_fkey`, `atomicassets_assets_collections_fkey`, or
`atomicassets_assets_templates_fkey`.** Every restart replays the same block
range and fails identically. The check could not find a parent row in
`atomicassets_schemas`, `atomicassets_collections`, or
`atomicassets_templates`. Either that row was never indexed, or it is present
and the lookup cannot see it, and those two causes need different repairs.

Settle which one first. The constraint resolves its parent through a unique
index, so an index that has lost the entry fails the check while ordinary
queries still return the row. Check the index itself, passing `heapallindexed`
so the check also reports heap rows the index no longer points at:

```sql
CREATE EXTENSION IF NOT EXISTS amcheck;
SELECT bt_index_check('atomicassets_schemas_pkey'::regclass, true);
```

An error there names the damage. `item order invariant violated` means the
entries are stored out of sort order, so lookups binary-search past rows that
exist. A plain `SELECT` cannot stand in for this check, because the planner may
answer it from a sequential scan or a different index and return the row either
way.

A lost entry on `character varying` keys usually means collation. Their btrees
order by the collation of the key columns, and moving a data directory onto a
base image with a different glibc or ICU invalidates that order silently.
PostgreSQL 15 and later record the version the database was built with:

```sql
SELECT datcollversion,
       pg_database_collation_actual_version(oid) AS actual_version
FROM pg_database WHERE datname = current_database();
```

Differing versions mean every text index in the database is suspect, not only
this one. PostgreSQL 14 does not record this, so on 14 treat a base-image
change as reason enough to reindex. Repair with
`REINDEX DATABASE CONCURRENTLY <database>`, then, on 15 and later,
`ALTER DATABASE <database> REFRESH COLLATION VERSION`. Refreshing first clears
the warning without repairing anything.

Reindexing one index unwedges the filler, but stop only there if the collation
is unchanged. Rebuilding concurrently needs room for a second copy of each
index and leaves invalid `_ccnew` indexes to drop if a run fails. System
catalogs are separate: they need `REINDEX SYSTEM <database>`, which cannot run
concurrently. Read a failure of the form
`could not create unique index ... Key ... is duplicated` as data damage rather
than a reindex problem: the broken ordering also let the uniqueness check pass
rows it should have rejected, and those duplicates have to go before the index
can be rebuilt.

When the index is sound, the parent row really is missing. The rest of this
entry covers that case.

These constraints are added `NOT VALID`, so the scan that would report existing
violations never runs. Later statements that write those rows are still checked,
and because the constraints are `DEFERRABLE INITIALLY DEFERRED`, that check
lands at `COMMIT` and fails the whole block group. An orphaned asset therefore
stays silent until a later block writes it, which is often a sale or a transfer
of an asset minted long before.

Compare the parent tables against a complete database for the same chain, such
as a public API for that chain. The numbers below mean nothing in isolation, so
run each query on both databases:

```sql
SELECT count(*) FROM atomicassets_schemas;

SELECT (created_at_block / 10000000) * 10000000 AS block_bucket, count(*)
FROM atomicassets_schemas GROUP BY 1 ORDER BY 1;
```

Equal counts do not prove the parent row is present, since one absence can hide
behind an unrelated extra row, but a bucket that falls short of the complete
database shows which stretch of history this database never received. Full
buckets missing only a handful of individual rows mean it was seeded from an
incomplete source. How far the filler has ingested is a separate question,
answered by `SELECT name, block_num FROM contract_readers;`, not by the newest
row in a parent table. Scope any orphan scan to one collection, because
`atomicassets_assets` holds hundreds of millions of rows on a busy chain.

Copying the missing parent rows from a complete database clears the current
block, but the next absent row wedges the filler the same way. Restoring a
published dump is the durable fix. See
[Restore from a published dump](#restore-from-a-published-dump).
`pnpm start:reconcile` seeds v2 contract state and template deletions and does
not rebuild base rows.

**The filler ingests at the chain's own block rate while it is far behind
head.** CPU sits near idle and restarting changes nothing. Nothing in the filler
throttles the rate, so the filler is waiting on something. The progress line says
what.

```
Reader atomic-1 - Progress: 451800000 / 452500000 (12.34%) Speed: 2.0 B/s 118 W/s [DS:0|SH:0|JQ:0] (Syncs in 1000 hours)
```

`W/s` counts database write operations, not blocks. `DS` counts blocks waiting on
the database stage and `SH` counts SHIP messages received but not started. Both
exclude the item running, and both stages run one at a time.

That last detail bounds the reading. With `ship_prefetch_blocks` set to 1 the
node never has a second block outstanding, so both counters sit at zero whatever
the cause. Take the live window from the `Requesting ship blocks` line at startup
before you trust a pair of zeros.

So a filler that is itself the bottleneck backs up, showing `DS` close to
`ship_ds_queue_size` and `SH` holding the remainder of the
`ship_prefetch_blocks` window. Both at zero means the node is not filling that
window and the filler is idle. That reading, not the block rate, decides where to
look.

The estimate is not itself a fault signal. It models the chain producing two
blocks per second while you sync, so an average below that prints
`(Syncs never)` and an average barely above it prints an enormous hour count.

With `DS` and `SH` both high and `W/s` low, the filler is waiting on something
other than the database. Redis is the first place to look, because head mode
publishes notifications from inside the commit path, and deserialization is the
second: it runs on the reader's own thread for contract traces and rows, so it
shows as one thread pinned while the deserializer workers idle.

A reader from before 2.3.2 could also be stuck in head mode while far behind,
because it derived that state from `contract_readers.live`, which is set on the
first arrival at head and never written back. From 2.3.2 a reader always starts
in catch-up mode and promotes itself on the first block that is either reversible
or within twice `db_group_blocks` of the head, so no flag needs clearing.

With `DS` and `SH` both high and `W/s` high, the database write path is the
limit. Raise `db_group_blocks` and `max_wal_size` together. See
[Filler throughput](#filler-throughput).

With both at zero, the SHIP node is the limit. One node fault is already ruled
out by steady progress: a range below the node's state-history retention floor
produces a reconnect loop, not slow progress. Confirm it with a log search for
`does not contain` and `Empty block #`.

The other is not ruled out by anything the filler prints. The blocks-behind
figure comes from the head the node reports over the same socket, which is the
node's own view of itself. A node that is replaying or lagging reports a stale
local head and still feeds the filler steadily. Compare that head against a
trusted source for the chain before concluding the node's chain state is
current.

Isolate the node by pointing the filler at a different one. `CHAIN_SHIP`
overrides the endpoint in `connections.config.json`, and the reader resumes from
its own checkpoint, so the swap costs nothing and reverses cleanly. A rate that
jumps against another node settles it. When the rate holds, measure disk service
time on the node's state-history volume and check whether the same process also
carries p2p sync and API traffic.

## Development

```sh
pnpm build         # compile TypeScript to ./build
pnpm check-types   # type-only check (no emit)
pnpm test          # run the unit test suite (mocha)
pnpm lint          # ESLint
pnpm dev:server    # rebuild + run server with --trace-warnings
pnpm dev:filler    # rebuild + run filler with --trace-warnings
```

Integration tests require a running Postgres and the connection config:

```sh
pnpm test:e2e:ci
```

## Releases

This project uses semantic versioning. Tagged releases are published to
[GitHub Releases](https://github.com/atomicassets/atomicassets-api/releases)
and the corresponding container image tags are pushed to GHCR.
[RELEASING.md](./RELEASING.md) covers how a release is cut and what its notes
carry, and [CHANGELOG.md](./CHANGELOG.md) is where the notes of each release are
written.

Two lines are published in parallel, so pick the tag that matches how much you
want moving under you. Everything below lives at
`ghcr.io/atomicassets/atomicassets-api`.

| Tag | Line | Moves? | What it tracks |
| --- | --- | --- | --- |
| `2.0.0` | 2.x | Never | One exact release. Pin an exact tag in production. |
| `2.0` | 2.x | Yes | The newest patch in the 2.0 minor. |
| `latest` | 2.x | Yes | The newest stable release on the current major. Convenient for a first look, wrong for a production pin. |
| `1.7.25` | 1.7 | Never | One exact release on the maintenance line. |
| `1.7` | 1.7 | Yes | The newest patch on the maintenance line, for deploys not yet ready for v2. |

The two lines differ in how their git tags are written: 2.x releases are tagged
`2.0.0` and 1.7 releases `v1.7.25`. The image tag drops the `v` either way, so
git `v1.7.25` publishes image `1.7.25`. Release candidates are published as
`2.0.0-rcN`; being prereleases they never move `2.0` or `latest`, so you have to
ask for one by name.

The codebase carries the full release history from the upstream
`pinknetworkx/eosio-contract-api` project (`v1.0.0-rc1` through `v1.3.21`)
plus all subsequent work done while it lived inside the atomichub monorepo.

## Contributing

Issues and pull requests are welcome. See
[CONTRIBUTING.md](./CONTRIBUTING.md) for development setup, commit
conventions, and the PR review process. Security reports go through
[SECURITY.md](./SECURITY.md).

## License

MIT. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).

## Acknowledgments

- [Pink Network](https://pink.gg) and Spielworks Markets GmbH built the
  original `eosio-contract-api` and the AtomicAssets / AtomicMarket /
  AtomicTools contract suites that this service indexes.
- The AtomicHub team and FACINGS for carrying the codebase forward and
  running it at scale across multiple Antelope chains.
- Everyone who has filed issues, opened PRs, and run nodes against this
  indexer.
