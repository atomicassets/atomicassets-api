-- Counting FUNCTION (was a per-row-COMMIT PROCEDURE before 1.6.5). One bounded,
-- set-based UPDATE per call, returning the rows resolved; the filler loops in
-- small batches within a time budget (drainAtomicmarketMints). Keeps each call
-- well under the 30s statement_timeout. See definitions/migrations/1.6.5.
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
$$
;
