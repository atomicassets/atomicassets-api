CREATE OR REPLACE VIEW atomicpacksx_packs_master AS
SELECT
    pack.contract,
    pack.pack_id,
    pack.assets_contract,
    pack.collection_name,
    pack.pack_template_id,
    pack.unlock_time,
    pack.display_data,
    -- Derived from atomicpacksx_claims so the counter stays correct across
    -- replays and reorgs without in-handler increment tracking.
    (SELECT COUNT(*)::bigint
       FROM atomicpacksx_claims cl
       WHERE cl.contract = pack.contract
         AND cl.pack_id  = pack.pack_id
    ) AS use_count,
    pack.created_at_block,
    pack.created_at_time,
    pack.updated_at_block,
    pack.updated_at_time,
    (SELECT json_agg(roll ORDER BY roll.roll_index)
       FROM (
         SELECT
           r.roll_index,
           r.total_odds,
           r.outcomes,
           r.display_data
         FROM atomicpacksx_pack_rolls r
         WHERE r.contract = pack.contract
           AND r.pack_id = pack.pack_id
       ) roll
    ) AS rolls,
    -- Match on the AtomicAssets contract too — multiple atomicassets
    -- contracts can coexist in the DB and collection_name alone is not
    -- unique across them.
    (SELECT row_to_json(c.*)
       FROM atomicassets_collections_master c
       WHERE c.contract = pack.assets_contract
         AND c.collection_name = pack.collection_name
    ) AS collection
FROM atomicpacksx_packs pack;
