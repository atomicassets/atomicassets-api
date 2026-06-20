-- 1.7.17 deferred - convert the atomicmarket seller/buyer indexes from hash to
-- btree online. Runs OUTSIDE the migration transaction (CREATE INDEX
-- CONCURRENTLY cannot run in a transaction); the deferred runner strips line
-- comments and splits on the semicolons below, executing each statement on its
-- own autocommit connection.
--
-- Per-index pattern (online, no long lock):
--   1. DROP any leftover *_btree from a previously interrupted run. CREATE
--      INDEX CONCURRENTLY IF NOT EXISTS would otherwise treat an INVALID
--      leftover as "already there" and skip the rebuild, and we would then
--      rename a broken index into place.
--   2. CREATE INDEX CONCURRENTLY the new btree under a *_btree name. This is
--      the slow step; CONCURRENTLY takes only SHARE UPDATE EXCLUSIVE so the
--      filler keeps writing and the API keeps reading throughout. The original
--      hash index stays valid until the new index is built.
--   3. DROP the old hash index, then RENAME *_btree to the canonical name.
--
-- The deferred runner bumps dbinfo.version to 1.7.17 BEFORE running this file
-- and never retries it, so building the new index first means a failure here
-- leaves the old hash index intact and the API serving normally.
--
-- atomicmarket_sales is by far the largest of these tables; the auctions,
-- buyoffers, and template_buyoffers builds are quick. On a deployment where
-- the sales build would exceed the runner's 1 hour per-statement timeout, run
-- these statements manually off-peak and set dbinfo.version = '1.7.17' before
-- deploying (see definitions/migrations/1.7.17/database.sql).

DROP INDEX IF EXISTS atomicmarket_sales_seller_btree;
CREATE INDEX CONCURRENTLY IF NOT EXISTS atomicmarket_sales_seller_btree ON atomicmarket_sales USING btree (seller);
DROP INDEX IF EXISTS atomicmarket_sales_seller;
ALTER INDEX atomicmarket_sales_seller_btree RENAME TO atomicmarket_sales_seller;

DROP INDEX IF EXISTS atomicmarket_sales_buyer_btree;
CREATE INDEX CONCURRENTLY IF NOT EXISTS atomicmarket_sales_buyer_btree ON atomicmarket_sales USING btree (buyer);
DROP INDEX IF EXISTS atomicmarket_sales_buyer;
ALTER INDEX atomicmarket_sales_buyer_btree RENAME TO atomicmarket_sales_buyer;

DROP INDEX IF EXISTS atomicmarket_auctions_seller_btree;
CREATE INDEX CONCURRENTLY IF NOT EXISTS atomicmarket_auctions_seller_btree ON atomicmarket_auctions USING btree (seller);
DROP INDEX IF EXISTS atomicmarket_auctions_seller;
ALTER INDEX atomicmarket_auctions_seller_btree RENAME TO atomicmarket_auctions_seller;

DROP INDEX IF EXISTS atomicmarket_auctions_buyer_btree;
CREATE INDEX CONCURRENTLY IF NOT EXISTS atomicmarket_auctions_buyer_btree ON atomicmarket_auctions USING btree (buyer);
DROP INDEX IF EXISTS atomicmarket_auctions_buyer;
ALTER INDEX atomicmarket_auctions_buyer_btree RENAME TO atomicmarket_auctions_buyer;

DROP INDEX IF EXISTS atomicmarket_buyoffers_seller_btree;
CREATE INDEX CONCURRENTLY IF NOT EXISTS atomicmarket_buyoffers_seller_btree ON atomicmarket_buyoffers USING btree (seller);
DROP INDEX IF EXISTS atomicmarket_buyoffers_seller;
ALTER INDEX atomicmarket_buyoffers_seller_btree RENAME TO atomicmarket_buyoffers_seller;

DROP INDEX IF EXISTS atomicmarket_buyoffers_buyer_btree;
CREATE INDEX CONCURRENTLY IF NOT EXISTS atomicmarket_buyoffers_buyer_btree ON atomicmarket_buyoffers USING btree (buyer);
DROP INDEX IF EXISTS atomicmarket_buyoffers_buyer;
ALTER INDEX atomicmarket_buyoffers_buyer_btree RENAME TO atomicmarket_buyoffers_buyer;

DROP INDEX IF EXISTS atomicmarket_template_buyoffers_seller_btree;
CREATE INDEX CONCURRENTLY IF NOT EXISTS atomicmarket_template_buyoffers_seller_btree ON atomicmarket_template_buyoffers USING btree (seller);
DROP INDEX IF EXISTS atomicmarket_template_buyoffers_seller;
ALTER INDEX atomicmarket_template_buyoffers_seller_btree RENAME TO atomicmarket_template_buyoffers_seller;

DROP INDEX IF EXISTS atomicmarket_template_buyoffers_buyer_btree;
CREATE INDEX CONCURRENTLY IF NOT EXISTS atomicmarket_template_buyoffers_buyer_btree ON atomicmarket_template_buyoffers USING btree (buyer);
DROP INDEX IF EXISTS atomicmarket_template_buyoffers_buyer;
ALTER INDEX atomicmarket_template_buyoffers_buyer_btree RENAME TO atomicmarket_template_buyoffers_buyer;
