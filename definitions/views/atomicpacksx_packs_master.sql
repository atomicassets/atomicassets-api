CREATE OR REPLACE VIEW atomicpacksx_packs_master AS
SELECT
    pack.contract,
    pack.pack_id,
    pack.collection_name,
    pack.pack_template_id,
    pack.unlock_time,
    pack.display_data,
    pack.use_count,
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
    (SELECT row_to_json(c.*)
       FROM atomicassets_collections_master c
       WHERE c.collection_name = pack.collection_name
    ) AS collection
FROM atomicpacksx_packs pack;
