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
