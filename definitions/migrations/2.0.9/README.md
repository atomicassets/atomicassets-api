# ECA 2.0.9: AtomicMarket v2 legacy bundle marker

Adds `atomicmarket_config.v2_marker_block`, the last block a market contract
still records under the pre-v2 rules, and backfills it where the chain is
already on v2. The legacy bundle rules apply from the block after it.

## Why

A sale, auction or buyoffer created before the AtomicMarket v2 upgrade may hold
more than one asset. The v2 contract refuses to create such a listing but keeps
the same actions working on the ones already on chain, and it cancels each of
them instead of settling: `purchasesale` erases the sale and charges the buyer
nothing, `auctionbid` and both auction claims dissolve an auction neither side
has claimed, and `acceptbuyo` refunds the buyer. The filler records the cancel
rather than a trade.

The stored contract version cannot gate those rules on its own. `deleteDB`
clears `atomicmarket_config`, and `AtomicMarketHandler.init` re-seeds it from a
head-time RPC read, so a full resync of a chain already on v2 reads version 2.x
while it replays pre-upgrade history. Gated on the version alone, that resync
would rewrite every real pre-upgrade bundle settlement as a cancel. The marker
separates the two: it records a flip the reader observed, never one inferred
from the head version.

## What the value means

`NULL` means unproven, and the rules stay off. The column takes a value from
one of two places:

- The config processor writes the block of the first `config` delta reporting
  major version 2 or above. A reader that is subscribed across the flip records
  it there, so its pre-flip history keeps the v1 recording and everything after
  the flip block gets the v2 recording. The flip block itself keeps the old
  recording, because `setversion` sits at some position inside it and an action
  earlier in that block settled for real under v1 code.
- This migration writes the furthest position reached by a reader whose `live`
  flag is true, for the deployment whose chain flipped before it took this
  release. That flip will never be re-announced, so nothing else would ever turn
  the rules on. `contract_readers.live` is the evidence that the reader stood at
  the chain head the stored version was read from: the filler writes it at every
  checkpoint from the processing state, and a fresh reader row starts false. The
  value is therefore provably past the flip, and since the rules start with the
  next block, it turns them on for the blocks still ahead and leaves the
  recorded history alone. `MAX` rather than `MIN`, because
  a reader replaying history from before the flip must keep the old recording
  instead of rewriting a settled trade as a cancel. A reader still catching up,
  and a reader whose position was rewound before this upgrade, both report
  `live` as false at their next checkpoint, so their deployment keeps a `NULL`
  marker until that reader observes the flip delta itself.

A row whose stored version is still pre-v2 is left `NULL`, and so is one whose
version does not read as a complete `major.minor.patch` with a major of 2 or
above, which is the shape the runtime gate parses. Marking a row the gate then
refuses to honor would leave a stale marker behind when a later delta corrects
the version. Those chains reach the flip in the reader's own timeline and the
processor writes the marker then.

A fresh install applies this file before any reader position or config row
exists, so the backfill matches nothing and the marker starts `NULL`. A reader
whose start block is after the flip is in that same position: it never observes
the flip delta, so its rules stay off until a later `config` delta arrives.

## Operator notes

The `ALTER TABLE` is metadata-only and instant. The backfill touches one row per
market contract. Both statements are idempotent and the file is safe to replay.
