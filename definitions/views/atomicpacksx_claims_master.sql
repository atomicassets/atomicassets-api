CREATE OR REPLACE VIEW atomicpacksx_claims_master AS
SELECT
    cl.contract,
    cl.claim_id,
    cl.pack_id,
    cl.opener,
    cl.pack_asset_id,
    cl.state,
    encode(cl.txid, 'hex') AS txid,
    cl.claimed_at_block,
    cl.claimed_at_time,
    cl.resolved_at_block,
    cl.resolved_at_time,
    pk.collection_name,
    pk.pack_template_id,
    pk.display_data AS pack_display_data,
    (SELECT json_agg(asset ORDER BY asset.index)
       FROM (
         SELECT a.asset_id, a."index"
         FROM atomicpacksx_claim_assets a
         WHERE a.contract = cl.contract
           AND a.claim_id = cl.claim_id
       ) asset
    ) AS result_assets,
    (SELECT row_to_json(c.*)
       FROM atomicassets_collections_master c
       WHERE c.collection_name = pk.collection_name
    ) AS collection
FROM atomicpacksx_claims cl
LEFT JOIN atomicpacksx_packs pk
       ON pk.contract = cl.contract
      AND pk.pack_id  = cl.pack_id;
