/*
  1.7.24 - see atomicmarket-deferred.sql: pin n_distinct on the asset_id column of
  atomicmarket_buyoffers_assets and atomicmarket_auctions_assets, so the planner
  stops pricing a nested loop over the existing asset_id index above a sequential
  scan of the whole junction table. Sampled n_distinct read 69,195 distinct values
  on wax mainnet against 1,468,586 actual, a 21x underestimate. Statistics only;
  no schema change in this file or any handler.
*/

UPDATE dbinfo SET "value" = '1.7.24' WHERE name = 'version';
