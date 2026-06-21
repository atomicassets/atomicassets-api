-- 1.5.1: atomicpacksx schema fixes for actual WAX ABI semantics.
--
-- 1.5.0 shipped handlers written against an incorrect ABI. The real WAX
-- atomicpacksx contract has different action shapes:
--
--   - `claimunboxed` (not `logclaim`) initiates a pack-open and carries
--     ONLY pack_asset_id - no pack_id, no claim_id, no opener (opener
--     comes from action authorization).
--   - `logresult` provides `template_ids` (templates the user will get)
--     and pack_id, NOT actual asset_ids and NOT claim_id.
--
-- This migration:
--   1. Relaxes `atomicpacksx_claims.pack_id` to nullable - claimunboxed
--      doesn't carry pack_id; first known at logresult time.
--   2. Adds (contract, pack_asset_id) index - logresult UPDATEs WHERE
--      pack_asset_id matches.
--   3. Adds `template_id bigint` column to atomicpacksx_claim_assets and
--      relaxes `asset_id` to nullable. logresult populates template_id;
--      asset_id stays NULL until atomicassets logmint notify backfills
--      it (future work).
--   4. Adds partial index on template_id.

ALTER TABLE atomicpacksx_claims
    ALTER COLUMN pack_id DROP NOT NULL;

CREATE INDEX IF NOT EXISTS atomicpacksx_claims_pack_asset_id
    ON atomicpacksx_claims USING btree (contract, pack_asset_id);

ALTER TABLE atomicpacksx_claim_assets
    ADD COLUMN IF NOT EXISTS template_id bigint;

ALTER TABLE atomicpacksx_claim_assets
    ALTER COLUMN asset_id DROP NOT NULL;

CREATE INDEX IF NOT EXISTS atomicpacksx_claim_assets_template_id
    ON atomicpacksx_claim_assets USING btree (template_id)
    WHERE template_id IS NOT NULL;

-- Drop the old non-partial asset_id index and recreate as partial since
-- asset_id is now mostly NULL until logmint notify lands.
DROP INDEX IF EXISTS atomicpacksx_claim_assets_asset_id;
CREATE INDEX IF NOT EXISTS atomicpacksx_claim_assets_asset_id
    ON atomicpacksx_claim_assets USING btree (asset_id)
    WHERE asset_id IS NOT NULL;
