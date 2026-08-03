/*
  1.7.27 - Cutover seed for the incremental template-price queue
  (the queue, triggers and drain are 1.7.26; the seed itself is atomicmarket.sql).

  WHY THE SEED IS ITS OWN VERSION
  1.7.26 replaces the enqueue triggers, and DROP TRIGGER takes ACCESS EXCLUSIVE
  on atomicmarket_stats_markets and atomicmarket_sales_filters_listed, the tables
  behind the market API's stats and /v2/sales reads. The runner holds every lock
  a version takes until that version commits, so any long statement sharing that
  transaction would hold ACCESS EXCLUSIVE for its whole duration, and PostgreSQL's
  FIFO lock queue would park every API read behind it for the same window. The
  seed is a multi-second full scan, so in one version it would have been a
  multi-second read outage on a live database at every filler boot that upgrades.

  Split across two versions, 1.7.26 commits as soon as its DDL is done and the
  ACCESS EXCLUSIVE locks release; the seed then runs here holding nothing heavier
  than ACCESS SHARE on the tables it reads.

  Reordering inside a single version was the rejected alternative. Putting the
  seed first releases no locks (they are taken later in the same transaction and
  still held to COMMIT) and opens a correctness hole: a row written between the
  seed's snapshot and the triggers becoming visible would be neither seeded nor
  enqueued, and nothing would ever recompute its template. Triggers first and
  seed second, in that order, has no such gap, because a write in the window is
  caught by the trigger and the seed's ON CONFLICT DO NOTHING then leaves that
  fresher row alone.

  WHY THIS FILE IS EMPTY OF DDL
  Same constraint as 1.7.26/database.sql: database.sql runs on every deployment,
  including ones with no atomicmarket handler, where the tables the seed reads do
  not exist. The seed therefore lives in the handler file, which those
  deployments skip, and this file only advances the version for them.

  The timeouts repeat 1.7.26's treatment and cover the whole version transaction.
  statement_timeout is lifted because the seed is the one statement here that can
  outrun the migration path's inherited 30s cap on a large or cold database.
  lock_timeout is 5s for consistency; the seed takes no conflicting lock, so it
  binds nothing in practice.
*/

SET LOCAL statement_timeout = 0;
SET LOCAL lock_timeout = '5s';

UPDATE dbinfo SET "value" = '1.7.27' WHERE name = 'version';
