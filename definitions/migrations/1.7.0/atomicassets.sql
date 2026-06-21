-- 1.7.0 - drop unused atomicassets index + clean up 1.3.15 drift.
-- atomicassets_template_counts_contract_template_id was dropped in 1.3.15 but drifted back
-- on some DBs; IF EXISTS makes this idempotent. See 1.7.0/database.sql.
-- (atomicassets_assets_contract_minted_at_time is KEPT - 6.4 GB but USED on the replica, 101 scans.)

DROP INDEX IF EXISTS atomicassets_template_counts_contract_template_id;
