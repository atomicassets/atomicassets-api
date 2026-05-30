/*
  1.6.5 - Bound update_atomicmarket_{sale,buyoffer,auction}_mints.

  Redefines the three mint-backfill PROCEDUREs as counting FUNCTIONs (one
  bounded set-based UPDATE per call, RETURNS rows resolved) so the filler can
  loop them in small batches within a time budget — fixing the recurring 57014
  on the default-pool 30s statement_timeout. See 1.6.5/atomicmarket.sql.

  Metadata-only DDL (DROP PROCEDURE + CREATE FUNCTION); no index work, so no
  deferred file and no statement_timeout override is needed.
*/

UPDATE dbinfo SET "value" = '1.6.5' WHERE name = 'version';
