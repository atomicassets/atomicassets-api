/*
  1.7.11 - Version-guarded, lock-light sales-filter drain (see database.sql for the why).

  Part 1: every enqueue path switches ON CONFLICT ... DO NOTHING -> DO UPDATE SET
  seq = nextval(...). A re-enqueue of an already-queued key now BUMPS its version token so
  the drain's end-DELETE (which matches on the captured seq) leaves it for reprocessing
  instead of silently dropping the change.

  Part 2: update_atomicmarket_sales_filters() no longer DELETE-claims at the start. It
  SELECTs (key, seq) into the temp tables (pure MVCC read, no queue lock), runs the
  recompute VERBATIM, then DELETEs only the claimed rows whose seq is unchanged, at the
  very end. The ~25s recompute therefore holds NO queue lock, so the reader's enqueue no
  longer speculative-waits on the drain transaction.

  CREATE OR REPLACE (no DROP) keeps the existing triggers bound to the enqueue functions.
*/

CREATE OR REPLACE FUNCTION update_atomicmarket_sales_filters_by_asset() RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO atomicmarket_sales_filters_updates(asset_contract, asset_id)
    VALUES (
        CASE TG_OP WHEN 'DELETE' THEN OLD.contract ELSE NEW.contract END,
        CASE TG_OP WHEN 'DELETE' THEN OLD.asset_id ELSE NEW.asset_id END
    )
    ON CONFLICT (asset_contract, asset_id) WHERE asset_id IS NOT NULL
        DO UPDATE SET seq = nextval('atomicmarket_sales_filters_updates_seq');

    RETURN NULL;
END
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION update_atomicmarket_sales_filters_by_offer() RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO atomicmarket_sales_filters_updates(asset_contract, offer_id)
    VALUES (
        CASE TG_OP WHEN 'DELETE' THEN OLD.contract ELSE NEW.contract END,
        CASE TG_OP WHEN 'DELETE' THEN OLD.offer_id ELSE NEW.offer_id END
    )
    ON CONFLICT (asset_contract, offer_id) WHERE offer_id IS NOT NULL
        DO UPDATE SET seq = nextval('atomicmarket_sales_filters_updates_seq');

    RETURN NULL;
END
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION update_atomicmarket_sales_filters_by_sale() RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO atomicmarket_sales_filters_updates(market_contract, sale_id)
    VALUES (
        CASE TG_OP WHEN 'DELETE' THEN OLD.market_contract ELSE NEW.market_contract END,
        CASE TG_OP WHEN 'DELETE' THEN OLD.sale_id ELSE NEW.sale_id END
    )
    ON CONFLICT (market_contract, sale_id) WHERE sale_id IS NOT NULL
        DO UPDATE SET seq = nextval('atomicmarket_sales_filters_updates_seq');

    RETURN NULL;
END
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION update_atomicmarket_sales_filters_by_contract_code() RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO atomicmarket_sales_filters_updates(market_contract, sale_id)
        SELECT market_contract, sale_id
        FROM atomicmarket_sales
        WHERE seller = ANY(ARRAY[
            CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN NEW.account END,
            CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN OLD.account END
        ])
    ON CONFLICT (market_contract, sale_id) WHERE sale_id IS NOT NULL
        DO UPDATE SET seq = nextval('atomicmarket_sales_filters_updates_seq');

    RETURN NULL;
END
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION refresh_atomicmarket_sales_filters_price() RETURNS VOID
LANGUAGE sql
AS $$
    INSERT INTO atomicmarket_sales_filters_updates (market_contract, sale_id)
        SELECT market_contract, sale_id
        FROM atomicmarket_sales_filters
        WHERE sale_state = 1 /* listing */
            AND variable_price
    ON CONFLICT (market_contract, sale_id) WHERE sale_id IS NOT NULL
        DO UPDATE SET seq = nextval('atomicmarket_sales_filters_updates_seq')
$$;

-- The drain. Identical to 1.6.3 EXCEPT: the three claim stages SELECT (key, seq) instead
-- of DELETE...RETURNING (no queue lock held across the recompute), and three
-- seq-version-guarded end-DELETEs run at the very end (release). The fan-out loop and the
-- recompute CTE block are byte-for-byte unchanged, preserving the 1.3.3-identical
-- atomicmarket_sales_filters output guarantee.
DROP FUNCTION IF EXISTS update_atomicmarket_sales_filters;
CREATE OR REPLACE FUNCTION update_atomicmarket_sales_filters(batch_size INT DEFAULT 5000) RETURNS INT
LANGUAGE plpgsql
AS $$
DECLARE
    r RECORD;
    deleted INT := 0;
    n INT;
BEGIN
    -- Serialize drains: only one may run at a time. The filler already uses a max=1 drain
    -- pool, but the SELECT-claim (unlike the old DELETE-claim) no longer mutually excludes
    -- a second drain, so a stray/manual concurrent burn-down would redo the (idempotent)
    -- recompute and risk filter-table deadlock. A txn-scoped advisory lock (auto-released at
    -- COMMIT) makes any concurrent drain a clean no-op. It is re-entrant within a transaction,
    -- so calling the function twice in one transaction (e.g. tests) still works.
    IF NOT pg_try_advisory_xact_lock(hashtext('update_atomicmarket_sales_filters')) THEN
        RETURN 0;
    END IF;

    -- Temp tables now carry the per-row seq captured at claim time (for the guarded
    -- end-DELETE). Plain temp tables (not ON COMMIT DROP) — explicitly dropped before
    -- RETURN — so the function is safe to call repeatedly on the reused longRunningPool
    -- connection and within a single test transaction.
    CREATE TEMPORARY TABLE _del_assets (asset_contract TEXT, asset_id BIGINT, seq BIGINT);
    CREATE TEMPORARY TABLE _del_sales (market_contract TEXT, sale_id BIGINT, seq BIGINT);
    CREATE TEMPORARY TABLE _del_offers (asset_contract TEXT, offer_id BIGINT, seq BIGINT);
    CREATE TEMPORARY TABLE sales_to_update (sale_id INT NOT NULL, market_contract TEXT NOT NULL, PRIMARY KEY (sale_id, market_contract));

    -- CLAIM (no lock): snapshot up to batch_size rows of each type with their seq.
    -- ORDER BY seq drains FIFO-ish and makes the batch deterministic; a row re-enqueued
    -- mid-batch gets a higher seq and is naturally claimed later. The function RETURNS rows
    -- DELETED (not claimed) — see the end-DELETE — so the caller's loop terminates when a
    -- batch makes no removal progress (e.g. only perpetually-re-touched keys remain),
    -- rather than spinning on claimed-but-never-deleted rows.
    INSERT INTO _del_assets
        SELECT asset_contract, asset_id, seq
        FROM atomicmarket_sales_filters_updates
        WHERE asset_id IS NOT NULL
        ORDER BY seq
        LIMIT batch_size;

    INSERT INTO _del_sales
        SELECT market_contract, sale_id, seq
        FROM atomicmarket_sales_filters_updates
        WHERE sale_id IS NOT NULL
        ORDER BY seq
        LIMIT batch_size;

    INSERT INTO _del_offers
        SELECT asset_contract, offer_id, seq
        FROM atomicmarket_sales_filters_updates
        WHERE offer_id IS NOT NULL
        ORDER BY seq
        LIMIT batch_size;

    -- Fan out the consumed asset changes to the sales that reference them, bucketed into
    -- <=50-asset overlap probes (verbatim from 1.3.3 / 1.6.3).
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

    -- Recompute affected sales — VERBATIM from 1.3.3 / 1.6.3 (`sales` reads _del_sales,
    -- `offers` reads _del_offers, both captured above). This is the heavy GIN-write part;
    -- it holds locks only on atomicmarket_sales_filters, NOT on the queue.
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
    SELECT COALESCE((SELECT COUNT(*) FROM ins_upd), 0)
        + COALESCE((SELECT COUNT(*) FROM del), 0)
    INTO n;

    -- RELEASE (the only place the queue is locked, ~ms at the very end): delete the claimed
    -- rows whose seq is UNCHANGED since the claim. A row re-enqueued mid-batch has a higher
    -- seq (the DO UPDATE bump above) and is left for the next batch -> no lost updates.
    DELETE FROM atomicmarket_sales_filters_updates u
        USING _del_assets d
        WHERE u.asset_id IS NOT NULL
            AND u.asset_contract = d.asset_contract AND u.asset_id = d.asset_id
            AND u.seq = d.seq;
    GET DIAGNOSTICS n = ROW_COUNT;
    deleted := deleted + n;

    DELETE FROM atomicmarket_sales_filters_updates u
        USING _del_sales d
        WHERE u.sale_id IS NOT NULL
            AND u.market_contract = d.market_contract AND u.sale_id = d.sale_id
            AND u.seq = d.seq;
    GET DIAGNOSTICS n = ROW_COUNT;
    deleted := deleted + n;

    DELETE FROM atomicmarket_sales_filters_updates u
        USING _del_offers d
        WHERE u.offer_id IS NOT NULL
            AND u.asset_contract = d.asset_contract AND u.offer_id = d.offer_id
            AND u.seq = d.seq;
    GET DIAGNOSTICS n = ROW_COUNT;
    deleted := deleted + n;

    DROP TABLE _del_assets, _del_sales, _del_offers, sales_to_update;

    -- Return queue rows actually REMOVED this call (not merely claimed): a row re-enqueued
    -- mid-batch has a bumped seq, survives the guarded end-DELETE, and is NOT counted — so
    -- the caller's `while (removed > 0)` loop stops making a pass that removed nothing
    -- (only hot/perpetually-re-touched keys left) instead of spinning a full recompute that
    -- deletes nothing. Empty queue → 0 → loop stops.
    RETURN deleted;
END
$$;
