/*
  2.0.9 - AtomicMarket v2 legacy bundle marker.

  Adds atomicmarket_config.v2_marker_block, the last block still recorded under
  the pre-v2 rules for this market contract. The legacy bundle rules apply from
  the block after it. A listing created before
  the v2 upgrade may hold more than one asset, and v2 cancels such a listing
  instead of settling it, so the filler records the cancel rather than a trade
  (src/filler/handlers/atomicmarket/legacy-bundles.ts).

  The rules cannot key off the stored contract version alone. deleteDB clears
  this table and AtomicMarketHandler.init re-seeds it from a head-time RPC read,
  so a full resync of a chain already on v2 would read version 2.x while
  replaying pre-upgrade history and would rewrite real trades as cancels. The
  marker is what separates the two: it records an observed flip, never one
  inferred from the head version, and NULL means unproven, which leaves the old
  recording in place.

  The backfill below covers the deployment that is already indexing a v2 chain,
  where the flip is in the past and no config delta will ever re-announce it. It
  gives the marker the furthest position a reader carrying contract_readers.live
  has reached. That flag is the evidence, and it is the only evidence here that
  a reader stood at the chain head the stored version was read from:
  src/filler/receiver.ts writes it at every checkpoint as state === HEAD, and a
  fresh reader row starts false. A live reader has therefore passed the flip,
  and its position is provably above it. The marker names the last block the old
  rules cover and the runtime gate starts with the next one, so the rules turn
  on for the blocks the reader has yet to process and stay off for the history
  it already recorded. MAX, not MIN: a reader replaying history from before the
  flip must keep the old recording rather than rewrite a settled trade as a
  cancel.

  A reader still catching up, and a reader whose position was rewound before
  this upgrade, both report live as false at their next checkpoint. They match
  nothing here, so their deployment keeps a NULL marker until that reader
  observes the flip delta itself.

  Rows whose stored version is still pre-v2 are left NULL on purpose. Those
  chains reach the flip in the reader's own timeline, and the config processor
  writes the marker at the block that carries the delta.

  A fresh install runs this file too, before any reader position or config row
  exists, so the backfill matches nothing and the marker starts NULL.
*/

SET LOCAL lock_timeout = '60s';

-- Metadata-only, so the ACCESS EXCLUSIVE lock is taken and released at once.
ALTER TABLE atomicmarket_config ADD COLUMN IF NOT EXISTS v2_marker_block bigint;

UPDATE atomicmarket_config config
SET v2_marker_block = reader.block_num
FROM (SELECT MAX(block_num) block_num FROM contract_readers WHERE block_num > 0 AND live) reader
WHERE config.v2_marker_block IS NULL
    AND reader.block_num IS NOT NULL
    -- The same complete major.minor.patch shape parseContractMajorVersion
    -- accepts, with a major of 2 or above, trimmed the way it trims. Matched
    -- rather than cast, so a version string carrying no number cannot abort the
    -- migration. Leading zeros are admitted because Number() reads them, so
    -- "02.0.0" is a v2 contract to the runtime gate and has to be one here too.
    -- A predicate looser or tighter than the gate leaves a row whose marker and
    -- rules disagree.
    AND btrim(config.version, E' \t\n\r') ~ '^0*(?:[2-9]|[1-9][0-9]+)\.[0-9]+\.[0-9]+$';
