-- atomicpacksx tables — pack templates, rolls (rarity distributions), claims
-- (user opens), and claim_assets (NFTs revealed by each claim).
--
-- Counter columns (e.g., pack open counts) are deliberately NOT stored on the
-- base tables. They are derived in the atomicpacksx_packs_master view from
-- the canonical atomicpacksx_claims rows so they stay correct across replays
-- and reorgs without any in-handler increment tracking.

CREATE TABLE IF NOT EXISTS atomicpacksx_config (
    contract character varying(12) NOT NULL,
    version character varying(64),
    CONSTRAINT atomicpacksx_config_pkey PRIMARY KEY (contract)
);

CREATE TABLE IF NOT EXISTS atomicpacksx_packs (
    contract character varying(12) NOT NULL,
    pack_id bigint NOT NULL,
    -- AtomicAssets contract that owns the collection — explicitly stored so
    -- views can join against atomicassets_collections_master on the full
    -- (contract, collection_name) compound key (multiple AtomicAssets
    -- contracts can coexist in a single DB).
    assets_contract character varying(12) NOT NULL,
    collection_name character varying(13) NOT NULL,
    pack_template_id bigint,
    unlock_time bigint,
    display_data text,
    created_at_block bigint NOT NULL,
    created_at_time bigint NOT NULL,
    updated_at_block bigint NOT NULL,
    updated_at_time bigint NOT NULL,
    CONSTRAINT atomicpacksx_packs_pkey PRIMARY KEY (contract, pack_id)
);

CREATE TABLE IF NOT EXISTS atomicpacksx_pack_rolls (
    contract character varying(12) NOT NULL,
    pack_id bigint NOT NULL,
    roll_index bigint NOT NULL,
    total_odds bigint NOT NULL,
    outcomes jsonb NOT NULL,
    display_data text,
    created_at_block bigint NOT NULL,
    created_at_time bigint NOT NULL,
    updated_at_block bigint NOT NULL,
    updated_at_time bigint NOT NULL,
    CONSTRAINT atomicpacksx_pack_rolls_pkey PRIMARY KEY (contract, pack_id, roll_index)
);

CREATE TABLE IF NOT EXISTS atomicpacksx_claims (
    contract character varying(12) NOT NULL,
    -- On WAX, `pack_asset_id` IS the chain-level claim identifier (each
    -- pack opening burns one specific NFT). The processor populates
    -- `claim_id` from `pack_asset_id` 1:1; the column name is preserved
    -- for downstream view/consumer compatibility.
    claim_id bigint NOT NULL,
    -- Nullable: WAX `claimunboxed` does NOT carry pack_id. It's first
    -- known at `logresult` time. The FK below stays valid because
    -- claims start with NULL pack_id (FK accepts NULL) and the UPDATE
    -- in logresult sets pack_id only after the parent pack row exists.
    pack_id bigint,
    opener character varying(12) NOT NULL,
    pack_asset_id bigint NOT NULL,
    -- state: 0=claimed (pending result), 1=resolved, 2=cancelled
    -- (no cancelled state on WAX — the chain has no cancelclaim action)
    state smallint NOT NULL DEFAULT 0,
    txid bytea,
    claimed_at_block bigint NOT NULL,
    claimed_at_time bigint NOT NULL,
    resolved_at_block bigint,
    resolved_at_time bigint,
    CONSTRAINT atomicpacksx_claims_pkey PRIMARY KEY (contract, claim_id)
);

CREATE TABLE IF NOT EXISTS atomicpacksx_claim_assets (
    contract character varying(12) NOT NULL,
    claim_id bigint NOT NULL,
    -- 1-based to match the rest of the schema (atomicassets_transfers_assets,
    -- atomicmarket_*_assets all use 1-based indices for ordered asset lists).
    "index" integer NOT NULL,
    -- WAX `logresult` provides `template_ids` (which template each minted
    -- NFT will be from), NOT the actual minted asset_ids. The asset_ids
    -- come later via atomicassets `logmint` notify (future work). Both
    -- columns are nullable because populated state depends on which side
    -- of the logresult → logmint chain has fired.
    asset_id bigint,
    template_id bigint,
    CONSTRAINT atomicpacksx_claim_assets_pkey PRIMARY KEY (contract, claim_id, "index")
);

-- FKs use ON DELETE RESTRICT so a stray DELETE against a parent row fails
-- loudly rather than silently dropping child data. Wholesale chain wipes go
-- through AtomicPacksHandler.deleteDB() which deletes children first.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'atomicpacksx_pack_rolls_pack_fkey') THEN
        ALTER TABLE ONLY atomicpacksx_pack_rolls
        ADD CONSTRAINT atomicpacksx_pack_rolls_pack_fkey FOREIGN KEY (contract, pack_id)
        REFERENCES atomicpacksx_packs (contract, pack_id) MATCH SIMPLE
        ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED NOT VALID;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'atomicpacksx_claims_pack_fkey') THEN
        ALTER TABLE ONLY atomicpacksx_claims
        ADD CONSTRAINT atomicpacksx_claims_pack_fkey FOREIGN KEY (contract, pack_id)
        REFERENCES atomicpacksx_packs (contract, pack_id) MATCH SIMPLE
        ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED NOT VALID;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'atomicpacksx_claim_assets_claim_fkey') THEN
        ALTER TABLE ONLY atomicpacksx_claim_assets
        ADD CONSTRAINT atomicpacksx_claim_assets_claim_fkey FOREIGN KEY (contract, claim_id)
        REFERENCES atomicpacksx_claims (contract, claim_id) MATCH SIMPLE
        ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED NOT VALID;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS atomicpacksx_packs_collection ON atomicpacksx_packs USING btree (assets_contract, collection_name);
CREATE INDEX IF NOT EXISTS atomicpacksx_packs_template ON atomicpacksx_packs USING btree (pack_template_id);
CREATE INDEX IF NOT EXISTS atomicpacksx_packs_updated_at_time ON atomicpacksx_packs USING btree (updated_at_time);

CREATE INDEX IF NOT EXISTS atomicpacksx_claims_pack ON atomicpacksx_claims USING btree (contract, pack_id);
CREATE INDEX IF NOT EXISTS atomicpacksx_claims_opener ON atomicpacksx_claims USING btree (opener);
CREATE INDEX IF NOT EXISTS atomicpacksx_claims_state ON atomicpacksx_claims USING btree (state);
CREATE INDEX IF NOT EXISTS atomicpacksx_claims_claimed_at_time ON atomicpacksx_claims USING btree (claimed_at_time);
CREATE INDEX IF NOT EXISTS atomicpacksx_claims_resolved_at_time ON atomicpacksx_claims USING btree (resolved_at_time);
-- pack_asset_id lookup: logresult UPDATEs by (contract, pack_asset_id)
-- since claim_id on WAX is derived from pack_asset_id 1:1 and the WHERE
-- clause uses the chain-natural identifier.
CREATE INDEX IF NOT EXISTS atomicpacksx_claims_pack_asset_id
    ON atomicpacksx_claims USING btree (contract, pack_asset_id);

CREATE INDEX IF NOT EXISTS atomicpacksx_claim_assets_asset_id
    ON atomicpacksx_claim_assets USING btree (asset_id) WHERE asset_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS atomicpacksx_claim_assets_template_id
    ON atomicpacksx_claim_assets USING btree (template_id) WHERE template_id IS NOT NULL;
