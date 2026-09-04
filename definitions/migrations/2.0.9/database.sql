/*
  2.0.9 - see atomicmarket.sql: adds atomicmarket_config.v2_marker_block, the
  last block a market contract still records under the pre-v2 rules, and
  backfills it for a deployment already indexing a v2 chain. The AtomicMarket
  v2 legacy bundle rules apply from the block after it. No shared table is
  altered.
*/

UPDATE dbinfo SET "value" = '2.0.9' WHERE name = 'version';
