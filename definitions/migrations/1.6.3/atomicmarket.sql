-- 1.6.3 - Bound update_atomicmarket_sales_filters() to `batch_size` queue rows
-- per call so a large backlog drains incrementally in short transactions
-- instead of one long, contention-heavy transaction. See
-- definitions/migrations/1.6.3/database.sql for the full rationale.
--
-- The function now:
--   * takes batch_size INT DEFAULT 5000
--   * consumes at most batch_size of each queue row type (asset/sale/offer)
--     per call, capturing the deleted rows into ON COMMIT DROP temp tables
--   * RETURNS the number of QUEUE ROWS CONSUMED this call (not filter rows
--     changed) so the caller loops until the queue is drained
--
-- The recompute (sales_to_insert_or_update CTE + the ins_upd / del block) is
-- IDENTICAL to 1.3.3 - only the queue-consume stages are bounded and the
-- `sales` / `offers` / asset inputs are repointed at the captured temp tables.
-- This guarantees byte-identical atomicmarket_sales_filters output vs 1.6.2;
-- only throughput/transaction-length changes.

DROP FUNCTION IF EXISTS update_atomicmarket_sales_filters;
CREATE OR REPLACE FUNCTION update_atomicmarket_sales_filters(batch_size INT DEFAULT 5000) RETURNS INT
LANGUAGE plpgsql
AS $$
DECLARE
    r RECORD;
    consumed INT := 0;
    n INT;
BEGIN
    -- Bounded consume of each queue row type into temp tables. ctid-LIMIT
    -- subselect caps work per call; RETURNING captures what we own so the
    -- recompute below operates only on the consumed slice. Temp tables are
    -- explicitly dropped at the end of the function (see the DROP before
    -- RETURN) - matching the original 1.3.3 proc's handling of sales_to_update
    -- - so the function is safe to call repeatedly on the same session
    -- (the filler longRunningPool reuses one connection) and within a single
    -- transaction (the test harness's txit), and an error mid-proc rolls back
    -- the temp tables with the aborted statement/transaction. (Plain temp
    -- tables, not ON COMMIT DROP, so no per-call DROP-IF-EXISTS notice spam.)
    CREATE TEMPORARY TABLE _del_assets (asset_contract TEXT, asset_id BIGINT);
    CREATE TEMPORARY TABLE _del_sales (market_contract TEXT, sale_id BIGINT);
    CREATE TEMPORARY TABLE _del_offers (asset_contract TEXT, offer_id BIGINT);
    CREATE TEMPORARY TABLE sales_to_update (sale_id INT NOT NULL, market_contract TEXT NOT NULL, PRIMARY KEY (sale_id, market_contract));

    WITH d AS (
        DELETE FROM atomicmarket_sales_filters_updates u
        WHERE u.ctid IN (
            SELECT ctid FROM atomicmarket_sales_filters_updates
            WHERE asset_id IS NOT NULL
            LIMIT batch_size
        )
        RETURNING asset_contract, asset_id
    )
    INSERT INTO _del_assets SELECT asset_contract, asset_id FROM d;
    GET DIAGNOSTICS n = ROW_COUNT;
    consumed := consumed + n;

    WITH d AS (
        DELETE FROM atomicmarket_sales_filters_updates u
        WHERE u.ctid IN (
            SELECT ctid FROM atomicmarket_sales_filters_updates
            WHERE sale_id IS NOT NULL
            LIMIT batch_size
        )
        RETURNING market_contract, sale_id
    )
    INSERT INTO _del_sales SELECT market_contract, sale_id FROM d;
    GET DIAGNOSTICS n = ROW_COUNT;
    consumed := consumed + n;

    WITH d AS (
        DELETE FROM atomicmarket_sales_filters_updates u
        WHERE u.ctid IN (
            SELECT ctid FROM atomicmarket_sales_filters_updates
            WHERE offer_id IS NOT NULL
            LIMIT batch_size
        )
        RETURNING asset_contract, offer_id
    )
    INSERT INTO _del_offers SELECT asset_contract, offer_id FROM d;
    GET DIAGNOSTICS n = ROW_COUNT;
    consumed := consumed + n;

    -- Fan out the consumed asset changes to the sales that reference them,
    -- bucketed into <=50-asset overlap probes (verbatim from 1.3.3, reading
    -- the captured _del_assets instead of an inline unbounded DELETE).
    FOR r IN
        WITH assets_with_bucket AS (
            SELECT asset_contract, asset_id, ROW_NUMBER() OVER () / 50 bucket
            FROM (
                SELECT DISTINCT asset_contract, asset_id
                FROM _del_assets
            ) d
        )
        SELECT asset_contract, ARRAY_AGG(asset_id) asset_ids
        FROM assets_with_bucket
        GROUP BY asset_contract, bucket
    LOOP
        INSERT INTO sales_to_update (sale_id, market_contract)
            SELECT m.sale_id, m.market_contract
            FROM atomicmarket_sales_filters m
            WHERE m.assets_contract = r.asset_contract
            	AND m.asset_ids && r.asset_ids
        ON CONFLICT DO NOTHING
        ;
    END LOOP;

    -- Recompute affected sales - VERBATIM from 1.3.3 except `sales` reads
    -- _del_sales and `offers` reads _del_offers (both already consumed above).
    WITH all_sales_to_update AS MATERIALIZED (
        SELECT market_contract, sale_id
        FROM _del_sales
        UNION
        SELECT market_contract, sale_id
        FROM sales_to_update
        UNION
        SELECT m.market_contract, m.sale_id
        FROM atomicmarket_sales_filters m
            JOIN _del_offers o ON m.assets_contract = o.asset_contract
                AND m.offer_id = o.offer_id
    ), sales_to_insert_or_update AS MATERIALIZED (
        SELECT
            listing.sale_id,
            listing.created_at_block,
            listing.offer_id,
            MIN(calc_listing_price(listing.final_price, listing.listing_price, pair.invert_delphi_pair, delphi.median, delphi.quote_precision, delphi.base_precision, delphi.median_precision)) AS price,
            CASE WHEN BOOL_OR(pair.invert_delphi_pair) IS NOT NULL THEN TRUE END variable_price,

            COUNT(DISTINCT asset.asset_id) asset_count,
            atomicmarket_get_sale_state(listing.state, offer.state) sale_state,

            create_atomicmarket_sales_filter(
                template_ids := ARRAY_AGG(DISTINCT asset.template_id) FILTER (WHERE asset.template_id IS NOT NULL),
                collection_names := ARRAY[listing.collection_name],
                data := ARRAY_AGG(DISTINCT data_props.ky || ':' || (data_props.val#>> '{}')) FILTER (WHERE data_props.ky NOT IN ('name', 'img') AND LENGTH(data_props.val#>> '{}') < 60),
                schema_names := ARRAY_AGG(DISTINCT asset.schema_name),
                sellers := ARRAY[listing.seller],
                buyers := ARRAY[listing.buyer],
                owners := ARRAY_AGG(DISTINCT asset.owner) FILTER (WHERE asset.owner IS NOT NULL),
                flags := CASE WHEN COUNT(asset.owner) FILTER (WHERE asset.owner IS NOT NULL) = 0 THEN ARRAY['b'] END -- burned
                	|| CASE WHEN COUNT(asset.template_id) FILTER (WHERE asset.template_id IS NOT NULL) = 0 THEN ARRAY['nt'] END -- no template
                	|| CASE WHEN BOOL_AND(template.transferable) IS DISTINCT FROM TRUE THEN ARRAY['nx'] END -- not transferable
                	|| CASE WHEN BOOL_AND(template.burnable) IS DISTINCT FROM TRUE THEN ARRAY['nb'] END -- not burnable
            ) AS filter,

    		ARRAY_AGG(DISTINCT asset.asset_id) asset_ids,

            STRING_AGG(DISTINCT (data_props.val#>> '{}'), e'\n') FILTER (WHERE data_props.ky = 'name') asset_names,

            listing.market_contract,
            listing.settlement_symbol,

            CASE WHEN MIN(asset.template_mint) IS NULL THEN 'empty'::int4range ELSE int4range(MIN(asset.template_mint), MAX(asset.template_mint), '[]') END AS template_mint,

            listing.assets_contract,

            listing.maker_marketplace,
            listing.taker_marketplace,
            listing.updated_at_time,
            listing.created_at_time,
            CASE WHEN cc.account IS NOT NULL THEN TRUE END seller_contract

        FROM atomicmarket_sales listing
            JOIN all_sales_to_update stu ON listing.market_contract = stu.market_contract AND listing.sale_id = stu.sale_id
            JOIN atomicassets_offers offer ON (listing.assets_contract = offer.contract AND listing.offer_id = offer.offer_id)
            JOIN atomicassets_offers_assets offer_asset ON offer_asset.offer_id = listing.offer_id AND offer_asset.contract = listing.assets_contract
            JOIN atomicassets_assets asset ON asset.contract = offer_asset.contract AND asset.asset_id = offer_asset.asset_id
            LEFT OUTER JOIN atomicassets_templates template ON asset.template_id = template.template_id AND asset.contract = template.contract

            LEFT OUTER JOIN atomicmarket_symbol_pairs pair ON pair.market_contract = listing.market_contract AND pair.listing_symbol = listing.listing_symbol AND pair.settlement_symbol = listing.settlement_symbol
            LEFT OUTER JOIN delphioracle_pairs delphi ON pair.delphi_contract = delphi.contract AND pair.delphi_pair_name = delphi.delphi_pair_name

            LEFT OUTER JOIN contract_codes cc ON listing.seller = cc.account

            LEFT OUTER JOIN LATERAL jsonb_each(COALESCE(asset.mutable_data, '{}') || COALESCE(asset.immutable_data, '{}') || COALESCE(template.immutable_data, '{}')) AS data_props(ky, val) ON TRUE
        WHERE (listing.state != 2) -- exclude cancelled
        GROUP BY listing.market_contract, listing.sale_id, sale_state, cc.account
    ), ins_upd AS (
        INSERT INTO atomicmarket_sales_filters AS m (sale_id, created_at_block, offer_id, price, variable_price,
            asset_count, sale_state, filter, asset_ids, asset_names, market_contract,
            settlement_symbol, template_mint, assets_contract,
            maker_marketplace, taker_marketplace, updated_at_time, created_at_time,
            seller_contract
        )
            SELECT
                sale_id, created_at_block, offer_id, price, variable_price,
                asset_count, sale_state, filter, asset_ids, asset_names, market_contract,
                settlement_symbol, template_mint, assets_contract,
                maker_marketplace, taker_marketplace, updated_at_time, created_at_time,
                seller_contract
            FROM sales_to_insert_or_update
        ON CONFLICT (sale_state, market_contract, sale_id)
            DO UPDATE SET
                created_at_block = EXCLUDED.created_at_block,
                offer_id = EXCLUDED.offer_id,
                price = EXCLUDED.price,
                variable_price = EXCLUDED.variable_price,
                asset_count = EXCLUDED.asset_count,
                filter = EXCLUDED.filter,
                asset_ids = EXCLUDED.asset_ids,
                asset_names = EXCLUDED.asset_names,
                settlement_symbol = EXCLUDED.settlement_symbol,
                template_mint = EXCLUDED.template_mint,
                assets_contract = EXCLUDED.assets_contract,
                maker_marketplace = EXCLUDED.maker_marketplace,
                taker_marketplace = EXCLUDED.taker_marketplace,
                updated_at_time = EXCLUDED.updated_at_time,
                created_at_time = EXCLUDED.created_at_time,
                seller_contract = EXCLUDED.seller_contract
            WHERE
                m.created_at_block IS DISTINCT FROM EXCLUDED.created_at_block
                OR m.offer_id IS DISTINCT FROM EXCLUDED.offer_id
                OR m.price IS DISTINCT FROM EXCLUDED.price
                OR m.variable_price IS DISTINCT FROM EXCLUDED.variable_price
                OR m.asset_count IS DISTINCT FROM EXCLUDED.asset_count
                OR m.filter IS DISTINCT FROM EXCLUDED.filter
                OR m.asset_ids IS DISTINCT FROM EXCLUDED.asset_ids
                OR m.asset_names IS DISTINCT FROM EXCLUDED.asset_names
                OR m.settlement_symbol IS DISTINCT FROM EXCLUDED.settlement_symbol
                OR m.template_mint IS DISTINCT FROM EXCLUDED.template_mint
                OR m.assets_contract IS DISTINCT FROM EXCLUDED.assets_contract
                OR m.maker_marketplace IS DISTINCT FROM EXCLUDED.maker_marketplace
                OR m.taker_marketplace IS DISTINCT FROM EXCLUDED.taker_marketplace
                OR m.updated_at_time IS DISTINCT FROM EXCLUDED.updated_at_time
                OR m.created_at_time IS DISTINCT FROM EXCLUDED.created_at_time
                OR m.seller_contract IS DISTINCT FROM EXCLUDED.seller_contract
        RETURNING 1
    ), del AS (
        DELETE FROM atomicmarket_sales_filters
        WHERE (sale_state, market_contract, sale_id) IN (
            SELECT UNNEST(ARRAY[0, 1, 2, 3, 4]) sale_state, market_contract, sale_id FROM all_sales_to_update
            EXCEPT
            SELECT sale_state, market_contract, sale_id FROM sales_to_insert_or_update
        )
        RETURNING 1
    )
    -- The SELECT...INTO is what drives the data-modifying CTEs above (ins_upd /
    -- del run for their side effects). plpgsql requires the top-level
    -- data-modifying-CTE query to land in a target, so we discard the count
    -- (filter rows changed) into the scratch var `n` - it is intentionally NOT
    -- the return value: it can be 0 via the IS DISTINCT FROM guards even when
    -- the queue still has work, which would falsely stop the caller's drain
    -- loop. The caller loops on `consumed` (queue rows removed) instead.
    SELECT COALESCE((SELECT COUNT(*) FROM ins_upd), 0)
        + COALESCE((SELECT COUNT(*) FROM del), 0)
    INTO n;

    DROP TABLE _del_assets, _del_sales, _del_offers, sales_to_update;

    -- Return queue rows CONSUMED this call so the caller loops until drained.
    RETURN consumed;
END
$$;
