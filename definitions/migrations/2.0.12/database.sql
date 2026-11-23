/*
  2.0.12 - see atomicassets.sql: adds the table that links a bridged
  AtomicAssets asset to the asset it was bridged from. database.sql runs on
  every install, including the ones that configure no atomicassets handler, so
  it touches no handler-owned table and only advances the version.

  lock_timeout bounds the lock wait of the handler file's CREATE INDEX: a
  version that cannot take its lock within 5s fails and retries on the next
  boot instead of queueing every reader behind it.
*/

SET LOCAL lock_timeout = '5s';

UPDATE dbinfo SET "value" = '2.0.12' WHERE name = 'version';
