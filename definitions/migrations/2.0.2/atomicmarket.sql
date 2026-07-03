/*
  2.0.2 - AtomicMarket v2 royalty read layer.

  The v2 contract settles collection fees through a royalty split engine: it
  stores its configuration in three contract tables (royaltyconf scoped to the
  contract, royaltytemp / royaltyattr scoped to the collection) and emits
  no-op inline log actions (logroyfound / logroytempl / logroyattr /
  logroydust) carrying the final per-recipient amounts at settlement.

  This migration adds:

  * atomicmarket_royalties_config / _templates / _attributes - raw row-for-row
    mirrors of the three config tables. No off-chain resolution or attribute
    matching is stored; the settled truth arrives via the payout log.
  * atomicmarket_royalty_payouts - one row per (log action, payout entry),
    keyed by the log trace's global_sequence + position in the payouts vector,
    which makes replays idempotent. listing_type/listing_id link the payout to
    the settlement action resolved from the same transaction; listing_type 0
    means the linkage could not be resolved (the payout is kept regardless).

  All tables are created empty here, so plain in-transaction CREATE INDEX is
  free and no *-deferred.sql (out-of-transaction CONCURRENTLY path) is needed.
*/

CREATE TABLE IF NOT EXISTS atomicmarket_royalties_config
(
    market_contract character varying(12) NOT NULL,
    collection_name character varying(12) NOT NULL,
    founders jsonb NOT NULL DEFAULT '[]'::jsonb,
    attribute_mode smallint NOT NULL DEFAULT 0,
    split_founders bigint NOT NULL DEFAULT 0,
    split_templates bigint NOT NULL DEFAULT 0,
    split_attributes bigint NOT NULL DEFAULT 0,
    updated_at_block bigint NOT NULL,
    updated_at_time bigint NOT NULL,
    created_at_block bigint NOT NULL,
    created_at_time bigint NOT NULL,
    CONSTRAINT atomicmarket_royalties_config_pkey PRIMARY KEY (market_contract, collection_name)
);

CREATE TABLE IF NOT EXISTS atomicmarket_royalties_templates
(
    market_contract character varying(12) NOT NULL,
    collection_name character varying(12) NOT NULL, -- royaltytemp delta scope
    template_id bigint NOT NULL,
    recipients jsonb NOT NULL,
    updated_at_block bigint NOT NULL,
    updated_at_time bigint NOT NULL,
    created_at_block bigint NOT NULL,
    created_at_time bigint NOT NULL,
    CONSTRAINT atomicmarket_royalties_templates_pkey PRIMARY KEY (market_contract, collection_name, template_id)
);

CREATE TABLE IF NOT EXISTS atomicmarket_royalties_attributes
(
    market_contract character varying(12) NOT NULL,
    collection_name character varying(12) NOT NULL, -- royaltyattr delta scope
    rule_id bigint NOT NULL, -- on-chain royaltyattr.index
    source smallint NOT NULL,
    field text NOT NULL,
    value jsonb NOT NULL, -- raw ["type", value] variant tuple
    weight bigint NOT NULL,
    recipients jsonb NOT NULL,
    lookup_hash bytea NOT NULL,
    updated_at_block bigint NOT NULL,
    updated_at_time bigint NOT NULL,
    created_at_block bigint NOT NULL,
    created_at_time bigint NOT NULL,
    CONSTRAINT atomicmarket_royalties_attributes_pkey PRIMARY KEY (market_contract, collection_name, rule_id)
);

CREATE TABLE IF NOT EXISTS atomicmarket_royalty_payouts
(
    market_contract character varying(12) NOT NULL,
    log_global_sequence bigint NOT NULL,
    payout_index integer NOT NULL,
    listing_type smallint NOT NULL, -- 1 sale, 2 auction, 3 buyoffer, 4 template_buyoffer, 0 unresolved
    listing_id bigint,
    category smallint NOT NULL, -- 1 founders, 2 template, 3 attribute, 4 dust
    collection_name character varying(12) NOT NULL,
    asset_id bigint,
    template_id bigint,
    rule_id bigint,
    recipient character varying(12) NOT NULL,
    amount bigint NOT NULL,
    token_symbol character varying(12) NOT NULL,
    txid bytea NOT NULL,
    created_at_block bigint NOT NULL,
    created_at_time bigint NOT NULL,
    CONSTRAINT atomicmarket_royalty_payouts_pkey PRIMARY KEY (market_contract, log_global_sequence, payout_index)
);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'atomicmarket_royalty_payouts_token_symbol_fkey') THEN
        ALTER TABLE ONLY atomicmarket_royalty_payouts
    ADD CONSTRAINT atomicmarket_royalty_payouts_token_symbol_fkey FOREIGN KEY (market_contract, token_symbol)
    REFERENCES atomicmarket_tokens (market_contract, token_symbol) MATCH SIMPLE ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED NOT VALID;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS atomicmarket_royalty_payouts_recipient
    ON atomicmarket_royalty_payouts (market_contract, recipient, created_at_time DESC);
CREATE INDEX IF NOT EXISTS atomicmarket_royalty_payouts_recipient_symbol
    ON atomicmarket_royalty_payouts (market_contract, recipient, token_symbol) INCLUDE (amount);
CREATE INDEX IF NOT EXISTS atomicmarket_royalty_payouts_collection
    ON atomicmarket_royalty_payouts (market_contract, collection_name, created_at_time DESC);
CREATE INDEX IF NOT EXISTS atomicmarket_royalty_payouts_listing
    ON atomicmarket_royalty_payouts (market_contract, listing_type, listing_id);
