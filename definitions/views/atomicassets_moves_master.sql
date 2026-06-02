CREATE OR REPLACE VIEW atomicassets_moves_master AS
    SELECT
        t1.move_id, t1.contract,
        t1.sender sender_name, t1.recipient recipient_name, t1.memo,
        encode(t1.txid::bytea, 'hex') txid,
        ARRAY(
            SELECT asset_t.asset_id
            FROM atomicassets_moves_assets asset_t
            WHERE asset_t.move_id = t1.move_id AND asset_t.contract = t1.contract
        ) assets,
        t1.created_at_block, t1.created_at_time
    FROM atomicassets_moves t1
