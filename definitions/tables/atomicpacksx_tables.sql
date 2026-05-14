-- atomicpacksx tables — pack templates, rolls (rarity distributions), claims
-- (user opens), and claim_assets (NFTs revealed by each claim).

CREATE TABLE IF NOT EXISTS atomicpacksx_config (
    contract character varying(12) NOT NULL,
    version character varying(64),
    CONSTRAINT atomicpacksx_config_pkey PRIMARY KEY (contract)
);

CREATE TABLE IF NOT EXISTS atomicpacksx_packs (
    contract character varying(12) NOT NULL,
    pack_id bigint NOT NULL,
    collection_name character varying(13) NOT NULL,
    pack_template_id bigint,
    unlock_time bigint,
    display_data text,
    use_count bigint NOT NULL DEFAULT 0,
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
    claim_id bigint NOT NULL,
    pack_id bigint NOT NULL,
    opener character varying(12) NOT NULL,
    pack_asset_id bigint NOT NULL,
    -- state: 0=claimed (pending result), 1=resolved, 2=cancelled
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
    "index" integer NOT NULL,
    asset_id bigint NOT NULL,
    CONSTRAINT atomicpacksx_claim_assets_pkey PRIMARY KEY (contract, claim_id, "index")
);

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

CREATE INDEX IF NOT EXISTS atomicpacksx_packs_collection ON atomicpacksx_packs USING btree (collection_name);
CREATE INDEX IF NOT EXISTS atomicpacksx_packs_template ON atomicpacksx_packs USING btree (pack_template_id);
CREATE INDEX IF NOT EXISTS atomicpacksx_packs_updated_at_time ON atomicpacksx_packs USING btree (updated_at_time);

CREATE INDEX IF NOT EXISTS atomicpacksx_claims_pack ON atomicpacksx_claims USING btree (contract, pack_id);
CREATE INDEX IF NOT EXISTS atomicpacksx_claims_opener ON atomicpacksx_claims USING btree (opener);
CREATE INDEX IF NOT EXISTS atomicpacksx_claims_state ON atomicpacksx_claims USING btree (state);
CREATE INDEX IF NOT EXISTS atomicpacksx_claims_claimed_at_time ON atomicpacksx_claims USING btree (claimed_at_time);
CREATE INDEX IF NOT EXISTS atomicpacksx_claims_resolved_at_time ON atomicpacksx_claims USING btree (resolved_at_time);

CREATE INDEX IF NOT EXISTS atomicpacksx_claim_assets_asset_id ON atomicpacksx_claim_assets USING btree (asset_id);
