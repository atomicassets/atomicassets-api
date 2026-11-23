/*
  2.0.13 - link table for a database that took 2.0.12 without this handler

  The handler's upgrade() re-applies atomicassets_assets_master, which joins
  atomicassets_original_mints. 2.0.12 created that table only for databases
  that configured the atomicassets handler at the time, so a database that
  configured it later reaches this version without it. Handler SQL runs before
  upgrade(), so these statements repeat the 2.0.12 DDL. Every one is
  idempotent and matches 2.0.12/atomicassets.sql and atomicassets_tables.sql.
*/

CREATE TABLE IF NOT EXISTS atomicassets_original_mints (
    contract character varying(12) NOT NULL,
    asset_id bigint NOT NULL,
    original_contract character varying(12) NOT NULL,
    original_asset_id bigint NOT NULL,
    original_mint bigint,
    block_num bigint NOT NULL,
    CONSTRAINT atomicassets_original_mints_pkey PRIMARY KEY (contract, asset_id)
);

CREATE INDEX IF NOT EXISTS atomicassets_original_mints_contract_mint
    ON atomicassets_original_mints USING btree (contract, original_mint);
