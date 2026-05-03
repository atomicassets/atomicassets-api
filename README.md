# atomicassets-api

The official AtomicAssets API service: an indexer and HTTP API for
[AtomicAssets](https://github.com/pinknetworkx/atomicassets-contract),
[AtomicMarket](https://github.com/pinknetworkx/atomicmarket-contract),
[AtomicTools](https://github.com/pinknetworkx/atomictools-contract), and
related on-chain contracts on Antelope (formerly EOSIO) chains.

This codebase is a continuation of `eosio-contract-api` originally built by
[Pink Network](https://pink.gg) and is now maintained by the AtomicAssets
community. See [NOTICE](./NOTICE) for the project's lineage.

## What it does

- Subscribes to a State History Plugin (SHIP) endpoint and indexes blocks
  into PostgreSQL in real time.
- Exposes a REST API documented via OpenAPI / Swagger at `/docs` covering:
  AtomicAssets (NFTs, templates, schemas, collections), AtomicMarket
  (sales, auctions, buy offers), AtomicTools (link claims), and curated
  collection lists.
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

Clone and install:

```sh
git clone https://github.com/atomicassets/atomicassets-api.git
cd atomicassets-api
pnpm install
```

Copy the example configs and edit them for your environment:

```sh
cp config/connections.config.example.json config/connections.config.json
cp config/server.config.example.json     config/server.config.json
cp config/readers.config.example.json    config/readers.config.json
```

Initialise the database schema and start the filler and server:

```sh
pnpm db:schema:init
pnpm start:filler   # in one terminal — indexes blocks from SHIP into Postgres
pnpm start:server   # in another — serves the REST + WebSocket API
```

The API will be available on port 9000 by default with Swagger UI at
[http://localhost:9000/docs](http://localhost:9000/docs).

### Docker

A standalone container image is published on every push to `main`:

```sh
docker pull ghcr.io/atomicassets/atomicassets-api:main
```

You can also build locally:

```sh
docker build -t atomicassets-api:local .
```

## Configuration

Three JSON files in `config/` drive runtime behaviour:

- `connections.config.json` — Postgres, Redis, RPC endpoints, SHIP endpoint.
- `readers.config.json` — which chains the filler will index, contract
  filters, start block, and dataset selection.
- `server.config.json` — HTTP server port, rate limits, CORS, cache
  policies, provider name and URL displayed in `/docs`.

See `config/*.example.json` for the full schema with comments.

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

MIT — see [LICENSE](./LICENSE) and [NOTICE](./NOTICE).

## Acknowledgments

- [Pink Network](https://pink.gg) and Spielworks Markets GmbH built the
  original `eosio-contract-api` and the AtomicAssets / AtomicMarket /
  AtomicTools contract suites that this service indexes.
- The AtomicHub team and FACINGS for carrying the codebase forward and
  running it at scale across multiple Antelope chains.
- Everyone who has filed issues, opened PRs, and run nodes against this
  indexer.
