-- Composite index for collection page asset queries with many owners.
-- The existing collection_schema_active index has owner as an INCLUDE column (leaf-only),
-- so queries with 200+ owners in equalMany() degrade to scanning 7M+ rows per schema.
-- This index makes owner a btree key, enabling efficient Nested Loop lookups per owner.
CREATE INDEX CONCURRENTLY IF NOT EXISTS atomicassets_assets_coll_schema_owner
    ON atomicassets_assets (contract, collection_name, schema_name, owner)
    WHERE owner IS NOT NULL;
