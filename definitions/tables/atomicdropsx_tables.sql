-- atomicdropsx tables — drop templates + claims.

CREATE TABLE IF NOT EXISTS atomicdropsx_config (
    contract character varying(12) NOT NULL,
    version character varying(64),
    CONSTRAINT atomicdropsx_config_pkey PRIMARY KEY (contract)
);

CREATE TABLE IF NOT EXISTS atomicdropsx_drops (
    contract character varying(12) NOT NULL,
    drop_id bigint NOT NULL,
    collection_name character varying(13) NOT NULL,
    assets_to_mint jsonb NOT NULL,
    listing_price numeric NOT NULL,
    listing_symbol character varying(12) NOT NULL,
    settlement_symbol character varying(12),
    price_recipient character varying(12) NOT NULL,
    auth_required boolean NOT NULL DEFAULT false,
    account_limit bigint NOT NULL DEFAULT 0,
    account_limit_cooldown bigint NOT NULL DEFAULT 0,
    max_claimable bigint NOT NULL DEFAULT 0,
    current_claimed bigint NOT NULL DEFAULT 0,
    start_time bigint,
    end_time bigint,
    display_data text,
    is_deleted boolean NOT NULL DEFAULT false,
    created_at_block bigint NOT NULL,
    created_at_time bigint NOT NULL,
    updated_at_block bigint NOT NULL,
    updated_at_time bigint NOT NULL,
    CONSTRAINT atomicdropsx_drops_pkey PRIMARY KEY (contract, drop_id)
);

CREATE TABLE IF NOT EXISTS atomicdropsx_claims (
    contract character varying(12) NOT NULL,
    claim_id bigint NOT NULL,
    drop_id bigint NOT NULL,
    claimer character varying(12) NOT NULL,
    amount bigint NOT NULL,
    total_price numeric,
    price_symbol character varying(12),
    is_whitelist boolean NOT NULL DEFAULT false,
    txid bytea,
    claimed_at_block bigint NOT NULL,
    claimed_at_time bigint NOT NULL,
    CONSTRAINT atomicdropsx_claims_pkey PRIMARY KEY (contract, claim_id)
);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'atomicdropsx_claims_drop_fkey') THEN
        ALTER TABLE ONLY atomicdropsx_claims
        ADD CONSTRAINT atomicdropsx_claims_drop_fkey FOREIGN KEY (contract, drop_id)
        REFERENCES atomicdropsx_drops (contract, drop_id) MATCH SIMPLE
        ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED NOT VALID;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS atomicdropsx_drops_collection ON atomicdropsx_drops USING btree (collection_name);
CREATE INDEX IF NOT EXISTS atomicdropsx_drops_active ON atomicdropsx_drops USING btree (is_deleted, end_time);
CREATE INDEX IF NOT EXISTS atomicdropsx_drops_updated_at_time ON atomicdropsx_drops USING btree (updated_at_time);

CREATE INDEX IF NOT EXISTS atomicdropsx_claims_drop ON atomicdropsx_claims USING btree (contract, drop_id);
CREATE INDEX IF NOT EXISTS atomicdropsx_claims_claimer ON atomicdropsx_claims USING btree (claimer);
CREATE INDEX IF NOT EXISTS atomicdropsx_claims_claimed_at_time ON atomicdropsx_claims USING btree (claimed_at_time);
