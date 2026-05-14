CREATE OR REPLACE VIEW atomicdropsx_claims_master AS
SELECT
    cl.contract,
    cl.claim_id,
    cl.drop_id,
    cl.claimer,
    cl.amount,
    cl.total_price,
    cl.price_symbol,
    cl.is_whitelist,
    encode(cl.txid, 'hex') AS txid,
    cl.claimed_at_block,
    cl.claimed_at_time,
    d.assets_contract,
    d.collection_name,
    d.assets_to_mint,
    d.listing_symbol,
    d.display_data AS drop_display_data,
    -- Match on the AtomicAssets contract too so the lookup stays correct
    -- when multiple atomicassets contracts coexist in the same DB.
    (SELECT row_to_json(c.*)
       FROM atomicassets_collections_master c
       WHERE c.contract = d.assets_contract
         AND c.collection_name = d.collection_name
    ) AS collection
FROM atomicdropsx_claims cl
LEFT JOIN atomicdropsx_drops d
       ON d.contract = cl.contract
      AND d.drop_id  = cl.drop_id;
