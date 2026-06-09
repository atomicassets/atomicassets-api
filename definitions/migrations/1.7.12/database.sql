/*
  1.7.12 - see atomicassets.sql: converge the legacy atomicassets_transfers primary key to
  (contract, transfer_id) so the filler write-buffer's `ON CONFLICT (contract, transfer_id)`
  transfer upsert has a matching unique index on databases that were upgraded from the
  pre-composite-PK schema. No cross-handler schema change in this file.
*/

UPDATE dbinfo SET "value" = '1.7.12' WHERE name = 'version';
