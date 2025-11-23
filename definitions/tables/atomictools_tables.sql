CREATE TABLE IF NOT EXISTS atomictools_config (
    tools_contract character varying(12) NOT NULL,
    version character varying(64) NOT NULL,
    assets_contract character varying(12) NOT NULL,
    CONSTRAINT atomictools_config_pkey PRIMARY KEY (tools_contract)
);

CREATE TABLE IF NOT EXISTS atomictools_links (
    tools_contract character varying(12) NOT NULL,
    link_id bigint NOT NULL,
    assets_contract character varying(12) NOT NULL,
    creator character varying(64) NOT NULL,
    claimer character varying(64),
    state integer NOT NULL,
    key_type integer NOT NULL,
    key_data bytea NOT NULL,
    memo character varying(256) NOT NULL,
    created_at_block bigint NOT NULL,
    created_at_time bigint NOT NULL,
    updated_at_block bigint NOT NULL,
    updated_at_time bigint NOT NULL,
    CONSTRAINT atomictools_links_pkey PRIMARY KEY (tools_contract, link_id)
);

CREATE TABLE IF NOT EXISTS atomictools_links_assets (
    tools_contract character varying(12) NOT NULL,
    link_id bigint NOT NULL,
    assets_contract character varying(12) NOT NULL,
    "index" integer,
    asset_id bigint NOT NULL,
    CONSTRAINT atomictools_links_assets_pkey PRIMARY KEY (tools_contract, link_id, assets_contract, asset_id)
);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'atomictools_links_assets_link_id_fkey') THEN
        ALTER TABLE ONLY atomictools_links_assets
    ADD CONSTRAINT atomictools_links_assets_link_id_fkey FOREIGN KEY (tools_contract, link_id)
    REFERENCES atomictools_links (tools_contract, link_id) MATCH SIMPLE ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED NOT VALID;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS atomictools_links_state ON atomictools_links USING btree (state);
CREATE INDEX IF NOT EXISTS atomictools_links_creator ON atomictools_links USING btree (creator);
CREATE INDEX IF NOT EXISTS atomictools_links_key_full ON atomictools_links USING btree (key_type, key_data);
CREATE INDEX IF NOT EXISTS atomictools_links_created_at_time ON atomictools_links USING btree (created_at_time);
CREATE INDEX IF NOT EXISTS atomictools_links_updated_at_time ON atomictools_links USING btree (updated_at_time);

CREATE INDEX IF NOT EXISTS atomictools_links_assets_asset_id ON atomictools_links_assets USING btree (asset_id);
