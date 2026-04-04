-- Covers: collection asset listing (ORDER BY asset_id DESC) and COUNT(*) by collection.
-- Queries: GET /atomicassets/v1/assets?collection_name=X and count=true variant.
-- The existing collection_name_btree is single-column and can't satisfy the
-- (contract, collection_name) filter + asset_id DESC sort without a heap sort.
CREATE INDEX CONCURRENTLY IF NOT EXISTS atomicassets_assets_contract_collection_asset_id
    ON atomicassets_assets (contract, collection_name, asset_id DESC);

-- Covers: COUNT(*) with minted_at_time filter (e.g. "assets minted after X").
-- Query: GET /atomicassets/v1/assets?after=X&count=true
-- The existing minted_at_time index is single-column; adding contract as a
-- leading key lets the planner narrow to the single contract value first.
CREATE INDEX CONCURRENTLY IF NOT EXISTS atomicassets_assets_contract_minted_at_time
    ON atomicassets_assets (contract, minted_at_time);
