/*
  2.0.5 - re-assert the sliced signature of refresh_atomicmarket_sales_filters_price.

  1.7.13 changed this function from no arguments to (slice, total_slices). Because
  that is a signature change rather than a body change, it could not be expressed as
  a plain CREATE OR REPLACE: the file drops the old overload and creates the new one.
  A database that ends up with only the no-argument form therefore fails every tick
  of the price refresh job, which calls the sliced form, with

      function refresh_atomicmarket_sales_filters_price(unknown, unknown) does not exist

  Observed on one deployment whose other five functions from the same file were
  present and correct, so this is specific to the object whose signature moved
  rather than a migration that failed as a whole.

  Both statements are no-ops where the schema is already right: the DROP names the
  superseded no-argument overload only, and the CREATE OR REPLACE rewrites an
  identical body. The definition below is 1.7.13's, unchanged.
*/

DROP FUNCTION IF EXISTS refresh_atomicmarket_sales_filters_price();

CREATE OR REPLACE FUNCTION refresh_atomicmarket_sales_filters_price(slice INT DEFAULT 0, total_slices INT DEFAULT 1) RETURNS VOID
LANGUAGE sql
AS $$
    INSERT INTO atomicmarket_sales_filters_updates (market_contract, sale_id, prio)
        SELECT market_contract, sale_id, 1
        FROM atomicmarket_sales_filters
        WHERE sale_state = 1 /* listing */
            AND variable_price
            -- stable, stateless slicing: each sale_id belongs to exactly one slice, so
            -- calls for slice 0..total_slices-1 cover the full set exactly once per cycle.
            -- NULLIF: a misconfigured manual call with total_slices = 0 degrades to a
            -- no-op (NULL predicate) instead of division-by-zero; an out-of-range slice
            -- is naturally empty. The filler's env parsing only produces values >= 1.
            AND sale_id % NULLIF(total_slices, 0) = slice
    ON CONFLICT (market_contract, sale_id) WHERE sale_id IS NOT NULL
        DO UPDATE SET seq = nextval('atomicmarket_sales_filters_updates_seq'),
                      -- never downgrade a pending real-time (prio 0) row
                      prio = LEAST(atomicmarket_sales_filters_updates.prio, 1::SMALLINT)
$$;
