CREATE OR REPLACE VIEW atomicdropsx_drops_master AS
SELECT
    d.contract,
    d.drop_id,
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
    d.current_claimed,
    d.start_time,
    d.end_time,
    d.display_data,
    d.is_deleted,
    d.created_at_block,
    d.created_at_time,
    d.updated_at_block,
    d.updated_at_time,
    (SELECT row_to_json(c.*)
       FROM atomicassets_collections_master c
       WHERE c.collection_name = d.collection_name
    ) AS collection
FROM atomicdropsx_drops d;
