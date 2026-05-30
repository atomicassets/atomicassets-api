/*
  1.6.5 - Bound the mint-backfill jobs.

  update_atomicmarket_{sale,buyoffer,auction}_mints were PROCEDUREs that, per
  60s tick, materialized up to 50k unmint-ed rows and looped `UPDATE …; COMMIT;`
  one row at a time. The whole CALL ran under the default pool's 30s
  statement_timeout and timed out (57014) on WAX every ~5 min, never finishing
  the post-incident template_mint catch-up, while each per-row UPDATE fired the
  by_sale enqueue trigger and kept atomicmarket_sales_filters_updates elevated.

  They can't use the sales-filter drain's `SET LOCAL statement_timeout` fix: a
  procedure with an internal COMMIT can't be called inside an explicit
  transaction (raises 2D000), and a connection-level timeout doesn't survive
  PgBouncer transaction pooling.

  Fix (mirrors the 1.6.3 sales-filter drain): redefine each as a counting
  FUNCTION that does ONE bounded, set-based `UPDATE … FROM new_mints` per call
  and RETURNS the rows resolved. The filler loops in small batches within a time
  budget (drainAtomicmarketMints), so every call is sub-second and well under
  30s — no timeout reliance, no 2D000. One small txn per batch replaces 50k
  per-row commits; the by_sale enqueue semantics are unchanged and the bounded
  sales-filter drain (+ 1.6.4 dedup) absorbs the enqueues.

  Drop the old routine first because CREATE OR REPLACE cannot change a routine's
  kind (procedure -> function). Use DROP ROUTINE (not DROP PROCEDURE): on a fresh
  DB the proc files run first and already create these as FUNCTIONs, so a later
  `DROP PROCEDURE` would raise 42809 ("is not a procedure"); DROP ROUTINE removes
  whichever kind exists (procedure on upgrade, function on fresh install).
*/

DROP ROUTINE IF EXISTS update_atomicmarket_sale_mints(TEXT, BIGINT, INT);
CREATE OR REPLACE FUNCTION update_atomicmarket_sale_mints(selected_contract TEXT, last_irreversible_block BIGINT, max_sales_to_update INT DEFAULT 2000) RETURNS INT
LANGUAGE plpgsql
AS $$
DECLARE
    updated INT;
BEGIN
    WITH sales_to_update AS MATERIALIZED (
        SELECT assets_contract, sale_id, offer_id
        FROM atomicmarket_sales
        WHERE template_mint IS NULL
            AND market_contract = selected_contract
            AND created_at_block <= last_irreversible_block
        LIMIT max_sales_to_update
    ), new_mints AS MATERIALIZED (
        SELECT
            listing.assets_contract,
            listing.sale_id,
            MIN(template_mint) min_template_mint,
            MAX(template_mint) max_template_mint
        FROM sales_to_update listing
            JOIN atomicassets_offers_assets asset ON (listing.assets_contract = asset.contract AND listing.offer_id = asset.offer_id)
            JOIN atomicassets_assets assets ON asset.asset_id = assets.asset_id AND asset.contract = assets.contract
        GROUP BY listing.assets_contract, listing.sale_id
        -- filter out sales where assets have a template id, but the mint is not yet set
        HAVING NOT BOOL_OR(assets.template_id IS NOT NULL AND assets.template_mint IS NULL)
    ), upd AS (
        UPDATE atomicmarket_sales listing
            SET template_mint =
                    CASE WHEN nm.min_template_mint IS NULL
                        THEN 'empty'
                        ELSE int4range(nm.min_template_mint, nm.max_template_mint, '[]')
                    END
        FROM new_mints nm
        WHERE listing.assets_contract = nm.assets_contract
            AND listing.sale_id = nm.sale_id
        RETURNING 1
    )
    SELECT count(*) INTO updated FROM upd;
    RETURN updated;
END
$$;

DROP ROUTINE IF EXISTS update_atomicmarket_buyoffer_mints(TEXT, BIGINT, INT);
CREATE OR REPLACE FUNCTION update_atomicmarket_buyoffer_mints(selected_contract TEXT, last_irreversible_block BIGINT, max_buyoffers_to_update INT DEFAULT 2000) RETURNS INT
LANGUAGE plpgsql
AS $$
DECLARE
    updated INT;
BEGIN
    WITH buyoffers_to_update AS MATERIALIZED (
        SELECT market_contract, buyoffer_id
        FROM atomicmarket_buyoffers
        WHERE template_mint IS NULL
            AND market_contract = selected_contract
            AND created_at_block <= last_irreversible_block
        LIMIT max_buyoffers_to_update
    ), new_mints AS MATERIALIZED (
        SELECT
            buyoffer.market_contract,
            buyoffer.buyoffer_id,
            MIN(template_mint) min_template_mint,
            MAX(template_mint) max_template_mint
        FROM buyoffers_to_update buyoffer
            JOIN atomicmarket_buyoffers_assets asset ON (buyoffer.market_contract = asset.market_contract AND buyoffer.buyoffer_id = asset.buyoffer_id)
            JOIN atomicassets_assets assets ON asset.asset_id = assets.asset_id AND asset.assets_contract = assets.contract
        GROUP BY buyoffer.market_contract, buyoffer.buyoffer_id
        -- filter out buyoffers where assets have a template id, but the mint is not yet set
        HAVING NOT BOOL_OR(assets.template_id IS NOT NULL AND assets.template_mint IS NULL)
    ), upd AS (
        UPDATE atomicmarket_buyoffers buyoffer
            SET template_mint =
                    CASE WHEN nm.min_template_mint IS NULL
                        THEN 'empty'
                        ELSE int4range(nm.min_template_mint, nm.max_template_mint, '[]')
                    END
        FROM new_mints nm
        WHERE buyoffer.market_contract = nm.market_contract
            AND buyoffer.buyoffer_id = nm.buyoffer_id
        RETURNING 1
    )
    SELECT count(*) INTO updated FROM upd;
    RETURN updated;
END
$$;

DROP ROUTINE IF EXISTS update_atomicmarket_auction_mints(TEXT, BIGINT, INT);
CREATE OR REPLACE FUNCTION update_atomicmarket_auction_mints(selected_contract TEXT, last_irreversible_block BIGINT, max_auctions_to_update INT DEFAULT 2000) RETURNS INT
LANGUAGE plpgsql
AS $$
DECLARE
    updated INT;
BEGIN
    WITH auctions_to_update AS MATERIALIZED (
        SELECT market_contract, auction_id
        FROM atomicmarket_auctions
        WHERE template_mint IS NULL
            AND market_contract = selected_contract
            AND created_at_block <= last_irreversible_block
        LIMIT max_auctions_to_update
    ), new_mints AS MATERIALIZED (
        SELECT
            auction.market_contract,
            auction.auction_id,
            MIN(template_mint) min_template_mint,
            MAX(template_mint) max_template_mint
        FROM auctions_to_update auction
            JOIN atomicmarket_auctions_assets asset ON (auction.market_contract = asset.market_contract AND auction.auction_id = asset.auction_id)
            JOIN atomicassets_assets assets ON asset.asset_id = assets.asset_id AND asset.assets_contract = assets.contract
        GROUP BY auction.market_contract, auction.auction_id
        -- filter out auctions where assets have a template id, but the mint is not yet set
        HAVING NOT BOOL_OR(assets.template_id IS NOT NULL AND assets.template_mint IS NULL)
    ), upd AS (
        UPDATE atomicmarket_auctions auction
            SET template_mint =
                    CASE WHEN nm.min_template_mint IS NULL
                        THEN 'empty'
                        ELSE int4range(nm.min_template_mint, nm.max_template_mint, '[]')
                    END
        FROM new_mints nm
        WHERE auction.market_contract = nm.market_contract
            AND auction.auction_id = nm.auction_id
        RETURNING 1
    )
    SELECT count(*) INTO updated FROM upd;
    RETURN updated;
END
$$;
