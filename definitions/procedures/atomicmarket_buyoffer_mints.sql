-- Counting FUNCTION (was a per-row-COMMIT PROCEDURE before 1.6.5). One bounded,
-- set-based UPDATE per call, returning the rows resolved; the filler loops in
-- small batches within a time budget (drainAtomicmarketMints). Keeps each call
-- well under the 30s statement_timeout. See definitions/migrations/1.6.5.
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
$$
;
