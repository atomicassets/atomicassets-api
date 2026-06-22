# atomicassets-api

An indexer and HTTP API for
[AtomicAssets](https://github.com/pinknetworkx/atomicassets-contract),
[AtomicMarket](https://github.com/pinknetworkx/atomicmarket-contract),
[AtomicTools](https://github.com/pinknetworkx/atomictools-contract), and
related on-chain contracts on Antelope (formerly EOSIO) chains.

This codebase is a continuation of `eosio-contract-api` originally built by
[Pink Network](https://pink.gg) and is now maintained by the AtomicAssets
community. See [NOTICE](./NOTICE) for the project's lineage.

> Moving an existing indexer (including one on the original
> `eosio-contract-api`) to v2? See [UPGRADING.md](./UPGRADING.md). Short version:
> no Postgres 18 needed, and you can upgrade before the chain switches to the v2
> contract.

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

See `config/*.example.json` for the full schema with comments.

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

**Index creation runs for hours during a dump restore.** See
[Restore from a published dump](#restore-from-a-published-dump). Restore with
`--jobs` and a raised `maintenance_work_mem`, and use a dump from 1.7.17 or
later (btree seller/buyer indexes).

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
