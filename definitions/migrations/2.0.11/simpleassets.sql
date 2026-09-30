/*
  2.0.11 - per-card-group mint numbering for simpleassets

  mint_number is the ordinal an asset holds within its card group, assigned
  once at create and never recomputed. mint_group is the group key the ordinal
  counts in: a JSON array of the create's category, then each configured
  mutable data field as a string. simpleassets_card_totals holds the total
  ever minted per group, which a burn does not lower, so a burned ordinal is
  never reused.
  bootstrap_baseline_block is the height of the imported snapshot: creates at
  or below it are already counted in the imported totals and get no number.

  Every statement is idempotent. Handler setup creates the tables from
  simpleassets_tables.sql, which already carries this DDL, and then replays
  every past version's simpleassets.sql on top of it.

  The new columns are nullable with no default, so each ADD COLUMN is a
  catalog-only change. The group index is built CONCURRENTLY in
  simpleassets-deferred.sql.
*/

ALTER TABLE simpleassets_config
    ADD COLUMN IF NOT EXISTS bootstrap_baseline_block bigint;

ALTER TABLE simpleassets_assets
    ADD COLUMN IF NOT EXISTS mint_number bigint,
    ADD COLUMN IF NOT EXISTS mint_group text;

CREATE TABLE IF NOT EXISTS simpleassets_card_totals (
    contract character varying(12) NOT NULL,
    author character varying(12) NOT NULL,
    mint_group text NOT NULL,
    total_ever bigint NOT NULL DEFAULT 0,
    CONSTRAINT simpleassets_card_totals_pkey PRIMARY KEY (contract, author, mint_group)
);
