-- 1.7.0 - drop unused atomictools index (replica-verified zero-scan on every chain).
-- atomictools_links_key_full is KEPT (used on the replica). See 1.7.0/database.sql.

DROP INDEX IF EXISTS atomictools_links_assets_asset_id;
