/*
  1.6.4 - Make the sales-filter queue enqueue paths idempotent.

  Paired with the UNIQUE partial indexes added in database.sql: every function
  that INSERTs into atomicmarket_sales_filters_updates now uses ON CONFLICT DO
  NOTHING so a key already queued (and not yet drained) is not enqueued again.
  Without this the new unique indexes would turn duplicate enqueues into errors
  on the hot trigger path.

  CREATE OR REPLACE (no DROP) keeps the existing triggers bound to these
  functions. The ON CONFLICT inference clause repeats each partial index's
  predicate so PostgreSQL targets the right partial unique index.
*/

CREATE OR REPLACE FUNCTION update_atomicmarket_sales_filters_by_asset() RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO atomicmarket_sales_filters_updates(asset_contract, asset_id)
    VALUES (
        CASE TG_OP WHEN 'DELETE' THEN OLD.contract ELSE NEW.contract END,
        CASE TG_OP WHEN 'DELETE' THEN OLD.asset_id ELSE NEW.asset_id END
    )
    ON CONFLICT (asset_contract, asset_id) WHERE asset_id IS NOT NULL DO NOTHING;

    RETURN NULL;
END
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION update_atomicmarket_sales_filters_by_offer() RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO atomicmarket_sales_filters_updates(asset_contract, offer_id)
    VALUES (
        CASE TG_OP WHEN 'DELETE' THEN OLD.contract ELSE NEW.contract END,
        CASE TG_OP WHEN 'DELETE' THEN OLD.offer_id ELSE NEW.offer_id END
    )
    ON CONFLICT (asset_contract, offer_id) WHERE offer_id IS NOT NULL DO NOTHING;

    RETURN NULL;
END
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION update_atomicmarket_sales_filters_by_sale() RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO atomicmarket_sales_filters_updates(market_contract, sale_id)
    VALUES (
        CASE TG_OP WHEN 'DELETE' THEN OLD.market_contract ELSE NEW.market_contract END,
        CASE TG_OP WHEN 'DELETE' THEN OLD.sale_id ELSE NEW.sale_id END
    )
    ON CONFLICT (market_contract, sale_id) WHERE sale_id IS NOT NULL DO NOTHING;

    RETURN NULL;
END
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION update_atomicmarket_sales_filters_by_contract_code() RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO atomicmarket_sales_filters_updates(market_contract, sale_id)
        SELECT market_contract, sale_id
        FROM atomicmarket_sales
        WHERE seller = ANY(ARRAY[
            CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN NEW.account END,
            CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN OLD.account END
        ])
    ON CONFLICT (market_contract, sale_id) WHERE sale_id IS NOT NULL DO NOTHING;

    RETURN NULL;
END
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION refresh_atomicmarket_sales_filters_price() RETURNS VOID
LANGUAGE sql
AS $$
    INSERT INTO atomicmarket_sales_filters_updates (market_contract, sale_id)
        SELECT market_contract, sale_id
        FROM atomicmarket_sales_filters
        WHERE sale_state = 1 /* listing */
            AND variable_price
    ON CONFLICT (market_contract, sale_id) WHERE sale_id IS NOT NULL DO NOTHING
$$;
