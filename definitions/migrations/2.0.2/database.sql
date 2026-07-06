/*
  2.0.2 - see atomicmarket.sql: read layer for the AtomicMarket v2 royalty
  split engine. Adds raw mirrors of the three on-chain royalty config tables
  (royaltyconf / royaltytemp / royaltyattr) and a settled-payout ledger fed by
  the logroyfound / logroytempl / logroyattr / logroydust inline log actions.
  No existing table is altered. The four AtomicMarket listing master views are
  re-applied with a trailing current_collection_fee column (live
  atomicassets_collections.market_fee) by the handler's 2.0.2 upgrade hook.
*/

UPDATE dbinfo SET "value" = '2.0.2' WHERE name = 'version';
