/*
  2.0.11 - see simpleassets.sql: adds the per-card-group mint numbering columns
  and the card totals table to the simpleassets handler. database.sql runs on
  every install, including the many that configure no simpleassets handler, so
  it touches no handler-owned table and only advances the version.

  lock_timeout bounds the ACCESS EXCLUSIVE wait of the handler file's
  ALTER TABLE statements: a version that cannot take its lock within 5s fails
  and retries on the next boot instead of queueing every reader behind it.
*/

SET LOCAL lock_timeout = '5s';

UPDATE dbinfo SET "value" = '2.0.11' WHERE name = 'version';
