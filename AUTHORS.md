# Authors and credits

The `atomicassets-api` (an indexer and HTTP API for AtomicAssets, AtomicMarket,
AtomicTools, and related contracts) originated as `eosio-contract-api`. AtomicAssets and
AtomicHub were created by **Pink Network ([pink.gg](https://pink.gg))**, the original
founders. Ownership later passed to **Spielworks** (Spielworks Markets GmbH) as the second
owner, and then to **FACINGS** as the third and current owner and maintainer. See `NOTICE`
and `LICENSE` for copyright.

## AtomicAssets v2

The AtomicAssets v2 work (dual ownership / renting with `move` and `logmove`, mutable
templates, schema media types, collection author swaps, and the related read-layer and
migration changes) was originally authored by **Fabian Emilius
([@fabian-emilius](https://github.com/fabian-emilius))**, in the
[wax-office-of-inspector-general/eosio-contract-api](https://github.com/wax-office-of-inspector-general/eosio-contract-api)
repository (the AtomicAssets 2.0 branch):

- Implement AtomicAssets 2.0 changes
- Fix filler bugs and add the move endpoint
- Fix the API schema

That work was developed against a 2024-11 `master`, before the 1.6.0 handler rewrite and
the 1.6/1.7 drain and performance hardening. Because it does not apply cleanly to the
current 1.7.x codebase, this repository carries it forward as a reconstruction onto 1.7.2
rather than a replay of the original commits. The original authorship is recorded here and
co-attributed on the v2 integration commit.

## v2 catch-up and upgrade-safety fixes

The catch-up and upgrade-safety fixes that shipped with the v2 release candidates
(deferring the market-stats recompute and the eager missing-mint reconciliation while the
reader is behind, and converging the legacy `atomicassets_transfers` primary key) were
contributed by **Igor Lins e Silva ([@igorls](https://github.com/igorls))**.
