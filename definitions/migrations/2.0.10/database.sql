/*
  2.0.10 - see atomicmarket.sql: rebuilds atomicmarket_stats_markets_updates
  with a dedup key, a claim/release token and absolute autovacuum thresholds,
  and replaces update_atomicmarket_stats_market() with a bounded, queue-driven
  drain on the 1.7.11 claim protocol. No shared table is altered: the rebuild
  and the trigger-function replacements touch only the queue and the four
  enqueue functions, so the market tables the API reads are never locked.
*/

SET LOCAL statement_timeout = 0;
SET LOCAL lock_timeout = '5s';

UPDATE dbinfo SET "value" = '2.0.10' WHERE name = 'version';
