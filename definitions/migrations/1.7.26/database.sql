/*
  1.7.26 - Incremental, queue-driven template-price recompute.
  (The schema, triggers and function body live in atomicmarket.sql; the cutover
  seed lives in 1.7.27. This file carries only the timeouts and the dbinfo bump.)

  WHY THIS FILE IS EMPTY OF DDL
  database.sql runs for EVERY deployment, with or without the atomicmarket
  handler, and a deployment without it never runs atomicmarket.sql at all
  (src/filler/upgrade-db.ts iterates the configured handlers). Every object this
  version touches (atomicmarket_template_prices, atomicmarket_stats_markets,
  atomicmarket_sales_filters_listed, atomicmarket_stats_prices_master) exists
  only on atomicmarket installs, so putting the queue table or its triggers here
  would abort the upgrade transaction with 42P01 on an atomicassets-only filler
  and crash-loop it at boot. 1.7.13/database.sql records the same constraint as
  the reason its ALTER carries IF EXISTS.

  WHY THE SEED IS A SEPARATE VERSION
  The runner holds every lock a version takes until that version's COMMIT, and
  this version's DROP TRIGGER statements take ACCESS EXCLUSIVE on
  atomicmarket_stats_markets and atomicmarket_sales_filters_listed, the tables
  behind the market API's stats and /v2/sales reads. A long statement in the same
  transaction would therefore hold those locks for its whole duration and stall
  every API reader on the same database behind them. Splitting the seed out lets
  this version commit as soon as its (fast) DDL is done, releasing the locks, and
  leaves the seed to run under ACCESS SHARE alone in 1.7.27.

  Ordering the seed BEFORE the DDL inside one version would also release nothing:
  the locks are taken later in the same transaction and still held to COMMIT, and
  it opens a correctness hole besides. A row written between the seed's snapshot
  and the triggers becoming visible would be neither seeded nor enqueued, and
  nothing would ever recompute its template. DDL first, seed second, in that
  order across two versions, has no such gap: a write in the window is caught by
  the trigger.

  SET LOCAL, not plain SET: the runner wraps each version in its own
  BEGIN/COMMIT, so a LOCAL setting covers this version's database.sql and every
  handler file that follows it in the same transaction, and reverts at COMMIT
  instead of leaking onto the filler's long-lived migration connection.
  statement_timeout is lifted because the migration path inherits a 30s cap that
  was chosen for runtime queries; nothing here approaches it on a healthy
  database, but a trigger DDL statement that has to wait behind a long-running
  reader should fail on the lock timeout below, not on a cap meant for something
  else.

  lock_timeout is 5s, the in-repo value for locking DDL, and the tradeoff is
  deliberate: a PENDING ACCESS EXCLUSIVE request queues every later request
  behind it, plain reads included, because the lock queue is FIFO. So the cost of
  waiting is paid by API readers, not by this migration. Failing after 5s and
  letting the filler's replay retry caps that cost at 5s per attempt; waiting 60s
  would stall reads for a minute per attempt. A migration that cannot get the
  lock at all crash-loops the filler, which is the loud failure this trades for.
*/

SET LOCAL statement_timeout = 0;
SET LOCAL lock_timeout = '5s';

UPDATE dbinfo SET "value" = '1.7.26' WHERE name = 'version';
