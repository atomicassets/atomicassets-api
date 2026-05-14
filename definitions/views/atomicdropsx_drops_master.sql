CREATE OR REPLACE VIEW atomicdropsx_drops_master AS
SELECT
    d.contract,
    d.drop_id,
    d.assets_contract,
    d.collection_name,
    d.assets_to_mint,
    d.listing_price,
    d.listing_symbol,
    d.settlement_symbol,
    d.price_recipient,
    d.auth_required,
    d.account_limit,
    d.account_limit_cooldown,
    d.max_claimable,
    -- Computed at view time from atomicdropsx_claims so the value is
    -- always consistent with the canonical claim history; no in-handler
    -- counter maintenance is required for correctness on replays/reorgs.
    COALESCE((SELECT SUM(cl.amount)::bigint
                FROM atomicdropsx_claims cl
                WHERE cl.contract = d.contract
                  AND cl.drop_id  = d.drop_id
             ), 0) AS current_claimed,
    d.start_time,
    d.end_time,
    d.display_data,
    d.is_deleted,
    d.created_at_block,
    d.created_at_time,
    d.updated_at_block,
    d.updated_at_time,
    -- Match on the AtomicAssets contract too — collection_name alone is
    -- not unique across multiple atomicassets contracts in the same DB.
    (SELECT row_to_json(c.*)
       FROM atomicassets_collections_master c
       WHERE c.contract = d.assets_contract
         AND c.collection_name = d.collection_name
    ) AS collection
FROM atomicdropsx_drops d;
