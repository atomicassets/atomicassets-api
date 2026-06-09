/*
  1.7.13 - Opt-in partition-parallel drain for large sales-filter backlogs.

  PROBLEM (hit live on WAX after a long catchup): update_atomicmarket_sales_filters()
  is intentionally single-flight (1.7.11 advisory lock), so a large queue backlog
  drains at one batch at a time. The recompute is random-read I/O bound (~tens of
  sales/s on a 460M-asset DB), so a multi-million-row backlog -- the normal result
  of a deep catchup, a bulk load, or an extended drain outage -- takes days-to-weeks
  to clear while /v2/sales serves increasingly stale filter rows. Single-flight is
  correct in steady state (concurrent unpartitioned drains could recompute the same
  sale from two backends and deadlock on atomicmarket_sales_filters), but it leaves
  no recovery path that uses the hardware: the recompute parallelizes perfectly
  ACROSS DISJOINT SALES, which is exactly what hash-partitioning the queue gives.

  FIX, three pieces (no change to update_atomicmarket_sales_filters itself, no
  steady-state behavior change -- nothing runs unless an operator launches it):

  * atomicmarket_sales_filters (assets_contract, offer_id) index. The drain resolves
    queued offer rows to their sales by joining the filter table on exactly these
    columns, which until now meant a hash join scanning the multi-GB filter
    partitions EVERY batch that contains offer rows. With the index it is
    batch_size probes. This also speeds the stock single-flight drain.

  * normalize_atomicmarket_sales_filters_offers(batch_size): converts queued offer
    rows into the equivalent queued sale rows (the same offer->sales resolution the
    stock drain performs, made durable in the queue instead of per-batch). After
    normalization the backlog is sale rows only, which is the shape the partition
    workers consume. Claim/release uses the same seq-version-guard protocol as the
    1.7.11 drain, so an offer re-enqueued mid-normalize survives (bumped seq).

  * update_atomicmarket_sales_filters_partition(part_count, part_index, batch_size):
    the 1.7.11 drain restricted to sale rows with sale_id % part_count = part_index.
    The recompute CTE block is byte-for-byte the 1.7.11 recompute (preserving the
    1.3.3-identical output guarantee); only the claim predicate and the lock
    protocol differ. Run N workers, one per part_index, each looping until 0.

  LOCK PROTOCOL. The stock drain takes the advisory lock
  hashtext('update_atomicmarket_sales_filters') EXCLUSIVELY (1.7.11, unchanged).
  Partition workers and the normalizer take the SAME key SHARED, plus their own
  exclusive sub-locks:

    stock drain      EXCLUSIVE(global)                 -- unchanged
    normalizer       SHARED(global) + EXCLUSIVE(normalize-key)
    worker i         SHARED(global) + EXCLUSIVE(partition-key, i)

  Shared-shared does not conflict => N workers run together. Shared-exclusive
  conflicts => while ANY worker batch is in flight the stock drain's try-lock
  fails and it returns 0 (its normal contended path -- the filler just retries
  next cycle); conversely workers no-op while a stock batch is mid-flight. The
  per-partition exclusive lock makes a doubly-launched worker a clean no-op.
  All locks are xact-scoped try-locks: no waiting, no orphaned locks on crash,
  and every claim/recompute/release stays one crash-safe transaction exactly
  like 1.7.11.

  WORKER DISJOINTNESS. Workers consume only sale rows, partitioned by
  sale_id % part_count, and the recompute touches atomicmarket_sales_filters rows
  keyed by that same (market_contract, sale_id) -- so two workers can never write
  the same filter row, which is the deadlock the single-flight lock exists to
  prevent. Asset rows are NOT partitionable (one asset fans out to arbitrary
  sales), so workers ignore them; the stock drain keeps owning that path. For
  bulk asset backlogs see the operator recipe in the PR/docs: when the asset
  backlog vastly exceeds the active-listing count it is cheaper to drop the
  asset rows and enqueue every non-terminal sale for recompute than to fan out
  millions of no-op GIN probes.
*/

SET LOCAL statement_timeout = 0;
SET LOCAL lock_timeout = '60s';

-- Offer->sales resolution: probes instead of per-batch filter-partition scans.
-- (Partitioned parent: builds/attaches per partition. On very large live DBs you
-- may pre-build per-partition CONCURRENTLY under the same names; this then
-- attaches them without rebuilding.)
CREATE INDEX IF NOT EXISTS atomicmarket_sales_filters_offer_id
    ON atomicmarket_sales_filters (assets_contract, offer_id);

-- Convert queued offer rows into the equivalent queued sale rows. Same
-- resolution the stock drain performs per batch (filter-table join on
-- (assets_contract, offer_id)), but written back to the queue so partition
-- workers can consume the result. Returns offer rows removed; loop until 0.
CREATE OR REPLACE FUNCTION normalize_atomicmarket_sales_filters_offers(batch_size INT DEFAULT 50000) RETURNS INT
LANGUAGE plpgsql
AS $$
DECLARE
    removed INT := 0;
BEGIN
    -- Never overlap a stock drain (it consumes offer rows itself); coexists
    -- with partition workers (shared-shared).
    IF NOT pg_try_advisory_xact_lock_shared(hashtext('update_atomicmarket_sales_filters')) THEN
        RETURN 0;
    END IF;
    -- At most one normalizer.
    IF NOT pg_try_advisory_xact_lock(hashtext('normalize_atomicmarket_sales_filters_offers')) THEN
        RETURN 0;
    END IF;

    CREATE TEMPORARY TABLE _norm_offers (asset_contract TEXT, offer_id BIGINT, seq BIGINT);

    -- CLAIM (no queue lock), 1.7.11 protocol.
    INSERT INTO _norm_offers
        SELECT asset_contract, offer_id, seq
        FROM atomicmarket_sales_filters_updates
        WHERE offer_id IS NOT NULL
        ORDER BY seq
        LIMIT batch_size;

    -- Enqueue the sales these offers resolve to. DO UPDATE bumps seq (1.7.11
    -- enqueue semantics) so an already-queued sale is reprocessed after this
    -- point in time.
    INSERT INTO atomicmarket_sales_filters_updates (market_contract, sale_id)
        SELECT DISTINCT m.market_contract, m.sale_id
        FROM atomicmarket_sales_filters m
            JOIN _norm_offers o ON m.assets_contract = o.asset_contract
                AND m.offer_id = o.offer_id
    ON CONFLICT (market_contract, sale_id) WHERE sale_id IS NOT NULL
        DO UPDATE SET seq = nextval('atomicmarket_sales_filters_updates_seq');

    -- RELEASE: drop the claimed offer rows whose seq is unchanged; a row
    -- re-enqueued mid-normalize (bumped seq) survives for the next pass.
    DELETE FROM atomicmarket_sales_filters_updates u
        USING _norm_offers d
        WHERE u.offer_id IS NOT NULL
            AND u.asset_contract = d.asset_contract AND u.offer_id = d.offer_id
            AND u.seq = d.seq;
    GET DIAGNOSTICS removed = ROW_COUNT;

    DROP TABLE _norm_offers;

    RETURN removed;
END
$$;

-- The 1.7.11 drain restricted to one hash partition of the queued SALE rows.
-- The recompute CTE block is byte-for-byte 1.7.11 (=> identical filter output);
-- only the claim predicate (sale rows of this partition) and the lock protocol
-- (shared global + exclusive per-partition) differ. Returns queue rows removed;
-- run one worker per part_index, each looping until 0.
CREATE OR REPLACE FUNCTION update_atomicmarket_sales_filters_partition(part_count INT, part_index INT, batch_size INT DEFAULT 5000) RETURNS INT
LANGUAGE plpgsql
AS $$
DECLARE
    deleted INT := 0;
    n INT;
BEGIN
    IF part_count IS NULL OR part_count < 1 OR part_index IS NULL OR part_index < 0 OR part_index >= part_count THEN
        RAISE EXCEPTION 'update_atomicmarket_sales_filters_partition: part_index % invalid for part_count %', part_index, part_count;
    END IF;

    -- SHARED on the stock drain's key: workers coexist with each other and the
    -- normalizer, never with the stock drain (whose unpartitioned claim could
    -- recompute the same sales from a second backend).
    IF NOT pg_try_advisory_xact_lock_shared(hashtext('update_atomicmarket_sales_filters')) THEN
        RETURN 0;
    END IF;
    -- EXCLUSIVE per partition slot: a doubly-launched worker is a clean no-op.
    IF NOT pg_try_advisory_xact_lock(hashtext('update_atomicmarket_sales_filters_partition'), part_index) THEN
        RETURN 0;
    END IF;

    CREATE TEMPORARY TABLE _part_sales (market_contract TEXT, sale_id BIGINT, seq BIGINT);

    -- CLAIM (no queue lock): this partition's sale rows only. Asset/offer rows
    -- are never claimed here (see header).
    INSERT INTO _part_sales
        SELECT market_contract, sale_id, seq
        FROM atomicmarket_sales_filters_updates
        WHERE sale_id IS NOT NULL AND sale_id % part_count = part_index
        ORDER BY seq
        LIMIT batch_size;

    -- Recompute -- VERBATIM from 1.7.11 except all_sales_to_update is just the
    -- claimed partition slice (no asset fan-out, no offer join: those row types
    -- are not claimed by partition workers).
    WITH all_sales_to_update AS MATERIALIZED (
        SELECT market_contract, sale_id
        FROM _part_sales
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

    -- RELEASE (1.7.11 protocol): delete the claimed rows whose seq is UNCHANGED;
    -- a sale re-enqueued mid-batch (bumped seq) survives for reprocessing.
    DELETE FROM atomicmarket_sales_filters_updates u
        USING _part_sales d
        WHERE u.sale_id IS NOT NULL
            AND u.market_contract = d.market_contract AND u.sale_id = d.sale_id
            AND u.seq = d.seq;
    GET DIAGNOSTICS n = ROW_COUNT;
    deleted := deleted + n;

    DROP TABLE _part_sales;

    -- Queue rows actually REMOVED (not merely claimed) -- caller loops until 0.
    RETURN deleted;
END
$$;
