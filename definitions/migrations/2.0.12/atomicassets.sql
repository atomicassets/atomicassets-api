/*
  2.0.12 - original mints of bridged assets

  One row links a bridged AtomicAssets asset to the asset it was bridged from
  on another standard, with that asset's mint number. A bridge pair is fixed
  for life, so a row never changes after its insert. The reader of the source
  standard writes the rows, so its own fork rollback and delete_data remove
  them. original_mint is null when the source asset has no mint number.

  Every statement is idempotent. Handler setup creates the table from
  atomicassets_tables.sql, which already carries this DDL, and then replays
  every past version's atomicassets.sql on top of it. The table is new and
  empty, so its index builds inside the migration transaction.
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
