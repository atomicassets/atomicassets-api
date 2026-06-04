/*
  1.7.5 - Wire up the dormant update_atomicmarket_template_buyoffer_mints drain.

  Redefines update_atomicmarket_template_buyoffer_mints as a counting FUNCTION
  (one bounded set-based UPDATE per call, RETURNS rows resolved), mirroring the
  1.6.5 conversion of the sale/buyoffer/auction mint procedures — which missed
  this one. The procedure existed and was loaded since 1.3.23 but was never in
  the filler's drain loop, so ~614k SOLD (state = 2) template_buyoffers on WAX
  mainnet accumulated template_mint IS NULL and were silently excluded from the
  min/max_template_mint filter and sort=template_mint on /v1/template_buyoffers.
  See 1.7.5/atomicmarket.sql; the filler now registers a 4th bounded drain job
  that self-backfills the backlog under the reader-priority gate.

  Metadata-only DDL (DROP ROUTINE + CREATE FUNCTION); no index work (the
  atomicmarket_template_buyoffers_missing_mint partial index already exists), so
  no deferred file and no statement_timeout override is needed.
*/

UPDATE dbinfo SET "value" = '1.7.5' WHERE name = 'version';
