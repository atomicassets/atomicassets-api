# ECA 2.0.3: v2 late-upgrader integrity marker

Adds `atomicassets_config.v2_marker_block`, the per-contract marker the v2
late-upgrader guard checks at filler startup (`AtomicAssetsHandler.init`,
`src/filler/handlers/atomicassets/index.ts`). It records that this indexer's
view of the AtomicAssets v2 contract tables (`templates2`, `schematypes`,
`authorswaps`) has no unhealed gap - a fresh install proves it as soon as
its live reader observes the on-chain v2 flip, and an existing pre-2.0 deploy
proves it by restoring a published dump or running `reconcile`.

An operator upgrading an existing 1.x deploy across the on-chain v2 flip
should read `UPGRADING.md`'s "Upgrading after the contracts are already
live" section before starting the 2.0 filler - it covers what the guard
checks, why it can refuse to start, and the recovery paths.
