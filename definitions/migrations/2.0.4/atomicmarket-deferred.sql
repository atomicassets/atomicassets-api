-- 2.0.4 deferred - correct the planner's asset_id cardinality estimate on the
-- buyoffer and auction junction tables. Runs OUTSIDE the migration transaction
-- so each catalog update commits and releases its lock before the ANALYZE that
-- follows it; the deferred runner strips line comments, splits on the
-- semicolons below, and executes each statement on its own autocommit
-- connection.
--
-- Postgres derives n_distinct from a sample, and for a high-cardinality column
-- in a large table that estimate can be wrong by orders of magnitude, always in
-- the direction of too few distinct values. On wax mainnet the sample put
-- atomicmarket_buyoffers_assets.asset_id at 69,195 distinct against 1,468,586
-- actual, so the planner expected 154 junction rows per asset where the true
-- figure is 7. That priced a nested loop over atomicmarket_buyoffers_assets_asset_id
-- roughly 21x above its real cost, and the planner chose a parallel sequential
-- scan of the whole 10.6M-row table instead. Every buyoffer request carrying a
-- template or asset filter paid it: measured against the production replica,
-- the sequential plan ran in 2.0s touching 110,132 buffers where the nested loop
-- ran in 52ms touching 4,854.
--
-- Raising the statistics target does not help; sample-based n_distinct
-- estimation is unreliable for this shape at any sample size, and the column is
-- already at 400. A negative override is a ratio of distinct values to live
-- rows, so it keeps rescaling as the table grows rather than going stale at a
-- fixed count.
--
-- The ratios below are measured on wax mainnet, which holds the overwhelming
-- majority of the data and is the only deployment where the sequential scans
-- were observed. Other chains differ, but all of them land within a small
-- factor of the truth rather than the 21x the sampler produced, and the goal is
-- the right order of magnitude rather than an exact figure. These are fixed
-- overrides that Postgres never re-derives, so they want revisiting if the
-- offer-to-asset ratio on a deployment ever shifts by more than a few times.
-- Reverting is `RESET (n_distinct)` on the column, which restores sampling.

ALTER TABLE atomicmarket_buyoffers_assets ALTER COLUMN asset_id SET (n_distinct = -0.137);

-- atomicmarket_auctions_assets carries the same defect at a smaller scale:
-- 73,468 sampled against 613,163 actual distinct, an 8x underestimate. Its
-- sequential-scan count is low today because the auction endpoints see far less
-- filtered traffic, so this is preventive rather than a fix for observed harm.
ALTER TABLE atomicmarket_auctions_assets ALTER COLUMN asset_id SET (n_distinct = -0.171);

-- An override only reaches the planner once the column's statistics are rebuilt,
-- which is what these do. They also make the setting self-sustaining: every later
-- ANALYZE reads the override again, and the value it writes into pg_statistic
-- stands between runs, so the correction does not decay with analyze frequency.
-- That matters most where the junction table is large. setAutoVacSettings derives
-- autovacuum_analyze_threshold from row count as threshold * 10, so once a table
-- passes five million rows autoanalyze needs a million modifications before it
-- will run, and on wax mainnet it has not yet done so; a smaller chain lands on a
-- lower branch and is analysed normally. Manual ANALYZE is not subject to that
-- threshold on any of them, so the statements below apply the override everywhere.
ANALYZE atomicmarket_buyoffers_assets;
ANALYZE atomicmarket_auctions_assets;
