-- ============================================================================
-- AtomicAssets v2 (ECA 2.0.0) schema migration.
--
-- All column adds below are metadata-only (nullable, or a constant default) so
-- they are instant even on WAX mainnet's ~475M-row atomicassets_assets — they do
-- NOT rewrite the table. The master views are recreated afterwards by
-- AtomicAssetsHandler.upgrade('2.0.0') (reads definitions/views/*.sql), where the
-- new columns are appended at the end so CREATE OR REPLACE VIEW needs no
-- DROP ... CASCADE of dependent atomicmarket views.
-- ============================================================================

-- Dual ownership (renting): `holder` = current possessor, `owner` = real owner.
-- New rows are populated by the filler (logmint/logtransfer/logmove). Existing
-- rows must be backfilled `holder = owner` ONCE, OUT-OF-BAND and BATCHED — a
-- single `UPDATE atomicassets_assets SET holder = owner` here would rewrite the
-- whole table inside the migration transaction and bust statement_timeout on
-- WAX. See 2.0.0/README.md for the batched backfill. (Release blocker — tracked
-- in the v2 audit.)
ALTER TABLE atomicassets_assets ADD COLUMN IF NOT EXISTS holder character varying(12);

-- Collection author swaps (pending acceptance): the proposed new author + the
-- acceptance date, surfaced until accept/reject clears them.
ALTER TABLE atomicassets_collections ADD COLUMN IF NOT EXISTS new_author_name character varying(12);
ALTER TABLE atomicassets_collections ADD COLUMN IF NOT EXISTS new_author_date bigint;

-- Schema media types (per-format-field mediatype/info), populated from the
-- contract `schematypes` table via the `setschematyp` action.
ALTER TABLE atomicassets_schemas ADD COLUMN IF NOT EXISTS types jsonb[] NOT NULL DEFAULT ARRAY[]::jsonb[];

-- Mutable template data + template lifecycle (deltemplate / redtemplmax).
ALTER TABLE atomicassets_templates ADD COLUMN IF NOT EXISTS mutable_data jsonb;
ALTER TABLE atomicassets_templates ADD COLUMN IF NOT EXISTS deleted_at_block bigint;
ALTER TABLE atomicassets_templates ADD COLUMN IF NOT EXISTS deleted_at_time bigint;

-- Asset moves (rental holder changes via the `move` / `logmove` action).
CREATE TABLE IF NOT EXISTS atomicassets_moves (
    move_id bigint NOT NULL,
    contract character varying(12) NOT NULL,
    "sender" character varying(12) NOT NULL,
    "recipient" character varying(12) NOT NULL,
    memo character varying(256) NOT NULL,
    txid bytea NOT NULL,
    created_at_block bigint NOT NULL,
    created_at_time bigint NOT NULL,
    CONSTRAINT atomicassets_moves_pkey PRIMARY KEY (contract, move_id)
);

CREATE TABLE IF NOT EXISTS atomicassets_moves_assets (
    move_id bigint NOT NULL,
    contract character varying(12) NOT NULL,
    "index" integer NOT NULL,
    asset_id bigint NOT NULL,
    CONSTRAINT atomicassets_moves_assets_pkey PRIMARY KEY (move_id, contract, asset_id)
);

-- Indexes (mirror the equivalents on atomicassets_transfers / _assets and owner).
CREATE INDEX IF NOT EXISTS atomicassets_assets_holder_btree ON atomicassets_assets USING btree (holder);
CREATE INDEX IF NOT EXISTS atomicassets_moves_sender ON atomicassets_moves USING btree (sender);
CREATE INDEX IF NOT EXISTS atomicassets_moves_recipient ON atomicassets_moves USING btree (recipient);
CREATE INDEX IF NOT EXISTS atomicassets_moves_created_at_time ON atomicassets_moves USING btree (created_at_time);
CREATE INDEX IF NOT EXISTS atomicassets_moves_assets_asset_id ON atomicassets_moves_assets USING btree (asset_id);
