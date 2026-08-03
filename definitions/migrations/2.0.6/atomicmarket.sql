/*
  2.0.6 - Incremental, queue-driven update_atomicmarket_template_prices()
  (see database.sql for the version bump and for why none of this is in it).

  THE SHAPE THIS AVOIDS
  A full-scan recompute drives itself from every template that has ever had a
  price row and runs as one uninterruptible statement. Measured on the WAX
  mainnet primary at 1s sampling, one such run holds the max-1 longRunningPool
  client on-CPU for 128s while the sales-filter drain queues behind it for the
  whole run and starts the instant the client releases. Block processing stalls
  for that window whenever the chain is busy, and the reader-lag gate is checked
  only at job start, so a run that begins healthy still finishes long after the
  reader has fallen behind. A full scan is also one of the largest standing I/O
  consumers on the database no matter how little actually changed.

  THE SHAPE HERE
  A queue (atomicmarket_template_prices_updates) carries the templates whose
  price inputs changed, and the drain works it in bounded batches. The driving
  set is the templates claimed in the batch. The per-template recompute carries
  1.3.14's loop body verbatim, so for a template with price inputs every written
  (market_contract, collection_name, symbol) row is byte-identical to what a full
  scan produces at the same point in time.

  QUEUE PROTOCOL (the 1.7.11/1.7.13 sales-filter protocol)
  * Dedup on (market_contract, assets_contract, template_id, kind). Depth is
    bounded at two rows per template, no matter how hot the template is.
  * Claim without locks: the drain SELECTs its batch, recomputes, and only then
    DELETEs the claimed rows guarded on the captured `seq`. A row re-enqueued
    mid-batch carries a bumped seq, survives the release and is recomputed next
    cycle. Nothing the block writer does ever waits on a claimed row, which is
    the whole point of the 1.7.11 rewrite.
  * prio lanes (1.7.13): claim is ORDER BY prio, seq. Real-time trigger enqueues
    ride prio 0; the cutover seed (2.0.7) and every aging row ride prio 1 so a
    user-visible sale is picked up by the very next batch regardless of seed
    backlog. A real-time enqueue upgrades an already-queued seed row to prio 0 in
    the same DO UPDATE that bumps seq, so "prio changed but seq unchanged" cannot
    occur and the (key, seq) release guard covers lane upgrades too.
  * One xact-scoped advisory try-lock makes any overlapping drain a clean no-op.
    Correctness under interleaved drains comes from the guarded release, not the
    lock; the lock only stops two backends redoing the same recompute, and it is
    what makes the drain the single writer of aging rows (below).
  * prio and seq are deliberately NOT indexed, for 1.7.13's reason: the claim is
    a seqscan plus top-N sort, and keeping both out of indexes keeps the hot
    ON CONFLICT bumps HOT-updatable inside the fillfactor 70 free space. The
    escape hatch, if the seed backlog makes the per-batch seqscan visible, is a
    partial (prio, seq) index via a later atomicmarket-deferred.sql.

  KINDS
    0  live    recompute as soon as the drain reaches it (refresh_at 0)
    1  aging   recompute when the template's next time boundary passes
  Both computed inputs decay with time: the min-price cap counts only listings
  OLDER than three days, so a listing crosses INTO the cap at its
  updated_at_time + 3d; the recent-sale window counts only sales YOUNGER than
  three days, so a sale drops OUT of it at its time + 3d. A template's suggested
  price therefore has to recompute when a boundary passes even if nothing touches
  it. Aging rows are claimable only once refresh_at passes, measured against the
  reader's block time (never wall clock: on a lagging filler the two diverge by
  the lag and a wall-clock probe would wake the drain for work the claim will not
  take).

  THE AGING ROW IS SELF-ARMING, AND THE DRAIN IS ITS ONLY WRITER
  One aging row per template cannot carry more than one boundary, and a template
  routinely has several pending: two listings crossing at T1 < T2, or a sale
  ageing out between them. A trigger-written aging row would have to pick one and
  lose the others, and neither choice is safe (keeping the latest skips the
  recompute at T1 and leaves the cap too high until T2; keeping the earliest
  fires at T1 and then forgets T2 entirely).

  So triggers do not write aging rows at all. After recomputing a template the
  drain arms exactly one aging row at that template's EARLIEST FUTURE boundary
  across both input classes, and the recompute that boundary triggers arms the
  next one. The queue therefore holds at most one aging row per template while
  still visiting every boundary in order. The arm runs AFTER the guarded release,
  which is load-bearing twice over: the claimed aging row is already gone, so the
  arm inserts a fresh row rather than colliding with the stale past boundary it
  just consumed, which LEAST would pin in the past and spin on forever; and the
  released count stays honest for the filler's burn-down loop. Because the drain
  is single-flight and is the only writer of kind 1, the ON CONFLICT branch on
  the arm is defensive.

  A template with no future boundary is not armed, so a quiet template holds no
  queue rows at all.

  TWO CLOCKS, AND WHY THEY CANNOT MISFIRE
  The recompute keeps 1.3.14's recent-sale window verbatim, wall clock and all
  (`time >= extract(epoch from now() - '3 days')`), because output parity with
  the full scan is the contract and changing that expression would break it.
  Everything else is block-time based: the claim gate and both arm predicates
  read MAX(block_time) FROM contract_readers. A reader's block time never runs
  ahead of wall clock, so a sale-expiry arm can only fire at or after the moment
  the sale actually leaves the wall-clock window, never before it. On a lagging
  filler the recompute is therefore late by the lag, which is the same staleness
  the lag already imposes on everything else, and never early in the way that
  would burn a visit on a sale still inside the window.

  ENQUEUE POINTS (live rows only)
  * atomicmarket_stats_markets, the resolved single-asset rows behind
    atomicmarket_stats_prices_master, which is where sales, auctions, buyoffers
    and template buyoffers land once final. DELETE enqueues from OLD:
    reversible-block rollback and update_atomicmarket_stats_market()'s own delete
    branch (1.3.15) both remove rows on the mainline path.
  * atomicmarket_sales_filters_listed, whose MIN(price) over single-asset
    listings older than three days is the cap on both suggested values.

  AUTHORITATIVE PER-TEMPLATE RECOMPUTE
  A claimed template with no rows left in atomicmarket_stats_prices_master has
  its atomicmarket_template_prices rows DELETED rather than left behind, so
  cleanup is event-driven and immediate and needs no sweep of its own. A
  template whose sale inputs vanish (reversible-block rollback, refund) enqueues
  through the stats-markets delete path and is reconciled by the drain that
  claims it. Price rows already orphaned when this version lands are covered by
  the cutover seed in 2.0.7, which includes every template present in
  atomicmarket_template_prices: such a template recomputes to empty inputs on its
  first claim and is removed then. Between the two versions the queue carries
  only what the triggers put in it, which is correct but partial; they apply back
  to back in one filler boot, so that state is not observable between them.

  ROLLBACK
  The zero-argument call update_atomicmarket_template_prices() resolves through
  the parameter default, so an image at an earlier tag calling it on that tag's
  five-minute cadence drains correctly, at one default batch per five minutes. That rate is far below seed-backlog or storm inflow, so
  a sustained rollback trades the stall fix for growing price staleness; it is
  the escape from a broken image, not a steady state. The queue and triggers stay
  in the database and need no schema rollback.

  REPLAY
  Fresh installs and the test database replay every migration unconditionally
  (src/bin/init-test-db.ts), so every statement here is idempotent: guarded table
  and index creation, drop-and-recreate for triggers, CREATE OR REPLACE for
  functions, and a name-only DROP FUNCTION for the one signature change (the
  parenthesized zero-argument form would not match the new one-argument function
  on a second pass, and the CREATE would then fail with 42723).
*/

-- Repeated from database.sql for legibility; both files run in one transaction,
-- so the LOCAL settings would carry over anyway. The 5s lock_timeout on the
-- trigger DDL below is the load-bearing one: its rationale, and why the cutover
-- seed is a separate version rather than another statement in this transaction,
-- are recorded in database.sql.
SET LOCAL statement_timeout = 0;
SET LOCAL lock_timeout = '5s';


-- Monotonic claim/release version token. Gaps are fine (a conflicting INSERT
-- still consumes a value). Created before the table so the column DEFAULT can
-- reference it.
CREATE SEQUENCE IF NOT EXISTS atomicmarket_template_prices_updates_seq;

CREATE TABLE IF NOT EXISTS atomicmarket_template_prices_updates (
    market_contract VARCHAR(12) NOT NULL,
    assets_contract VARCHAR(12) NOT NULL,
    template_id BIGINT NOT NULL,
    -- 0 live, 1 aging (see the header).
    kind SMALLINT NOT NULL,
    -- Epoch milliseconds, the same unit as atomicmarket_sales_filters.updated_at_time,
    -- atomicmarket_stats_markets."time" and contract_readers.block_time. Three days is
    -- 3600 * 24 * 3 * 1000. Live rows keep 0 so they are always claimable.
    refresh_at BIGINT NOT NULL DEFAULT 0,
    -- 0 real-time, 1 bulk (cutover seed and aging rows).
    prio SMALLINT NOT NULL DEFAULT 0,
    seq BIGINT NOT NULL DEFAULT nextval('atomicmarket_template_prices_updates_seq')
);

-- Tie the sequence lifecycle to the column so it is dropped with the table (no
-- orphaned sequence on a future recreate). OWNED BY does not affect the DEFAULT.
ALTER SEQUENCE atomicmarket_template_prices_updates_seq
    OWNED BY atomicmarket_template_prices_updates.seq;

-- Storage tuning matching the 1.7.11 sales-filter queue. Every re-enqueue of an
-- already-queued key is a DO UPDATE and so writes a dead tuple on the hot
-- block-write path; the live row count is small, so the default scale-factor
-- autovacuum would almost never fire. Absolute thresholds reclaim those tuples,
-- and fillfactor 70 keeps the updates HOT (in-page), which is what keeps them
-- from spawning index entries. The sibling queue
-- atomicmarket_stats_markets_updates carries no such tuning and bloats for it.
ALTER TABLE atomicmarket_template_prices_updates SET (
    autovacuum_vacuum_scale_factor = 0.0,
    autovacuum_vacuum_threshold = 1000,
    autovacuum_vacuum_insert_scale_factor = 0.0,
    autovacuum_vacuum_insert_threshold = 1000,
    fillfactor = 70
);

-- Dedup key, and the ON CONFLICT arbiter for every enqueue below. Built here,
-- before the seed, so it builds on an empty table and the seed can use it. Not
-- CONCURRENTLY: the runner wraps the version in a transaction, and there is
-- nothing to build against.
CREATE UNIQUE INDEX IF NOT EXISTS atomicmarket_template_prices_updates_key
    ON atomicmarket_template_prices_updates (market_contract, assets_contract, template_id, kind);


/*
  Enqueue on atomicmarket_stats_markets: a sale, auction, buyoffer or template
  buyoffer reaching its final state, resolved to a single asset with a template.

  Both sides of an UPDATE are captured, not only the mainline one. An UPDATE that
  moves a stats row from one template to another, or off the single-asset shape
  that makes it a price input at all, takes an input away from OLD's template and
  gives one to NEW's, and OLD's template has to recompute or its price rows keep
  counting a sale it no longer has.
*/
CREATE OR REPLACE FUNCTION update_atomicmarket_template_prices_by_stats_markets() RETURNS TRIGGER AS $$
DECLARE
    old_market VARCHAR(12);
    old_assets VARCHAR(12);
    old_template BIGINT;
    new_market VARCHAR(12);
    new_assets VARCHAR(12);
    new_template BIGINT;
BEGIN
    IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.asset_id IS NOT NULL AND OLD.template_id IS NOT NULL THEN
        old_market := OLD.market_contract;
        old_assets := OLD.assets_contract;
        old_template := OLD.template_id;
    END IF;

    IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.asset_id IS NOT NULL AND NEW.template_id IS NOT NULL THEN
        new_market := NEW.market_contract;
        new_assets := NEW.assets_contract;
        new_template := NEW.template_id;
    END IF;

    IF old_template IS NULL AND new_template IS NULL THEN
        RETURN NULL;
    END IF;

    -- The recompute this wakes arms the template's next aging boundary, so this
    -- sale's own three-day expiry needs no row here. GROUP BY collapses the
    -- ordinary case where both sides carry the same key: ON CONFLICT DO UPDATE
    -- cannot affect one row twice in a single command (21000).
    INSERT INTO atomicmarket_template_prices_updates AS q (market_contract, assets_contract, template_id, kind, prio, refresh_at)
        SELECT v.market_contract, v.assets_contract, v.template_id, 0, 0, 0
        FROM (VALUES
            (old_market, old_assets, old_template),
            (new_market, new_assets, new_template)
        ) AS v(market_contract, assets_contract, template_id)
        WHERE v.template_id IS NOT NULL
        GROUP BY v.market_contract, v.assets_contract, v.template_id
    ON CONFLICT (market_contract, assets_contract, template_id, kind)
        DO UPDATE SET seq = nextval('atomicmarket_template_prices_updates_seq'),
                      prio = 0;

    RETURN NULL;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS atomicmarket_stats_markets_update_template_prices_tr ON atomicmarket_stats_markets;
CREATE TRIGGER atomicmarket_stats_markets_update_template_prices_tr
    AFTER UPDATE OR INSERT OR DELETE ON atomicmarket_stats_markets
    FOR EACH ROW
    EXECUTE FUNCTION update_atomicmarket_template_prices_by_stats_markets();


/*
  Enqueue on atomicmarket_sales_filters_listed: the min-price cap input.

  Only single-asset listings outside the seller-contract exclusion reach the cap,
  so each side of the row qualifies only when it satisfies both, matching the
  recompute's own predicate exactly. That also makes the template extraction
  exact rather than arbitrary: a single-asset listing carries at most one
  't'-prefixed entry in `filter` (create_atomicmarket_sales_filter, 1.3.1), so
  the first one is the only one.

  Delphi-driven repricing enqueues here and is meant to: the sales-filter drain
  copies updated_at_time straight from atomicmarket_sales
  (2.0.1/atomicmarket.sql, `listing.updated_at_time` in the recompute select
  list and `updated_at_time = EXCLUDED.updated_at_time` in the upsert), so a
  variable-price rewrite moves `price` while leaving the three-day cap clock at
  its chain-sourced value. A listing older than three days therefore stays inside
  the cap window across a repricing, and its new price is a genuine change to the
  cap. Excluding drain-originated rewrites would silently freeze every
  variable-price template's cap at whatever the delphi median was when the
  listing was last touched on chain.
*/
CREATE OR REPLACE FUNCTION update_atomicmarket_template_prices_by_listing() RETURNS TRIGGER AS $$
DECLARE
    old_template BIGINT;
    new_template BIGINT;
BEGIN
    -- price and seller_contract are the only columns of a listed row the cap
    -- reads: price is the value it minimises, seller_contract decides whether
    -- the row is in the input set at all. An UPDATE that moves neither cannot
    -- move any template's cap. asset_count is not in this gate because it cannot
    -- change: a sale's assets are fixed by the offer it was created from.
    IF TG_OP = 'UPDATE'
        AND OLD.price IS NOT DISTINCT FROM NEW.price
        AND OLD.seller_contract IS NOT DISTINCT FROM NEW.seller_contract
    THEN
        RETURN NULL;
    END IF;

    -- Per-side qualification is what makes a seller_contract flip enqueue from
    -- the correct side: TRUE to NULL qualifies NEW (the listing joins the cap's
    -- input set), NULL to TRUE qualifies OLD (it leaves, and the cap that
    -- counted it has to be recomputed without it).
    IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.asset_count = 1 AND OLD.seller_contract IS DISTINCT FROM TRUE THEN
        SELECT SUBSTRING(f FROM 2)::BIGINT
        INTO old_template
        FROM UNNEST(OLD.filter) u(f)
        WHERE f LIKE 't%'
        LIMIT 1;
    END IF;

    IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.asset_count = 1 AND NEW.seller_contract IS DISTINCT FROM TRUE THEN
        SELECT SUBSTRING(f FROM 2)::BIGINT
        INTO new_template
        FROM UNNEST(NEW.filter) u(f)
        WHERE f LIKE 't%'
        LIMIT 1;
    END IF;

    IF old_template IS NULL AND new_template IS NULL THEN
        RETURN NULL;
    END IF;

    -- Live row only; the recompute it wakes arms this listing's three-day
    -- crossing along with every other pending boundary for the template.
    INSERT INTO atomicmarket_template_prices_updates AS q (market_contract, assets_contract, template_id, kind, prio, refresh_at)
        SELECT v.market_contract, v.assets_contract, v.template_id, 0, 0, 0
        FROM (VALUES
            (CASE WHEN old_template IS NOT NULL THEN OLD.market_contract END, CASE WHEN old_template IS NOT NULL THEN OLD.assets_contract END, old_template),
            (CASE WHEN new_template IS NOT NULL THEN NEW.market_contract END, CASE WHEN new_template IS NOT NULL THEN NEW.assets_contract END, new_template)
        ) AS v(market_contract, assets_contract, template_id)
        WHERE v.template_id IS NOT NULL
        GROUP BY v.market_contract, v.assets_contract, v.template_id
    ON CONFLICT (market_contract, assets_contract, template_id, kind)
        DO UPDATE SET seq = nextval('atomicmarket_template_prices_updates_seq'),
                      prio = 0;

    RETURN NULL;
END
$$ LANGUAGE plpgsql;

-- The trigger is bound to the partition, not the parent: DELETE and UPDATE reach
-- the leaf whichever relation the statement names, and the parent carries the
-- other four sale states, none of which feed the cap.
DROP TRIGGER IF EXISTS atomicmarket_sales_filters_listed_update_template_prices_tr ON atomicmarket_sales_filters_listed;
CREATE TRIGGER atomicmarket_sales_filters_listed_update_template_prices_tr
    AFTER UPDATE OR INSERT OR DELETE ON atomicmarket_sales_filters_listed
    FOR EACH ROW
    EXECUTE FUNCTION update_atomicmarket_template_prices_by_listing();


/*
  The drain. The FOR loop body and the sug LATERAL carry 1.3.14's expressions
  verbatim, so the values written per template match a full scan's exactly. The
  properties that make the incremental form work:

  * `templates` is the claimed batch, so the driving set never scans
    atomicmarket_stats_prices_master (which would be a full scan of
    atomicmarket_stats_markets).
  * `sales` is restricted to the claimed templates through the GIN filter index,
    so a batch reads only those templates' listings rather than the whole listed
    partition. The CTE is joined USING (template_id, assets_contract), so the
    restriction cannot change any claimed template's min_price; and any listing
    of a claimed template carries that template's 't' entry, so none is missed.
    The `&&` may also pull in a listing of another assets_contract that shares a
    template_id; the USING join discards it.
  * The batch is claimed by SELECT and released by a (key, seq)-guarded DELETE
    near the end, so the recompute holds no queue lock and the block writer's
    enqueue never speculative-waits on this transaction (1.7.11's protocol).
  * A claimed template with no rows in the stats view has its price rows deleted
    (see AUTHORITATIVE PER-TEMPLATE RECOMPUTE in the header). `input_count` is
    the count over the same union the suggested values are computed from, which
    is empty exactly when the template has no rows in the view: the LIMIT 5 arm
    returns at least one row whenever any exists.
  * After the release, every claimed template arms its next aging boundary (see
    THE AGING ROW IS SELF-ARMING in the header).

  RETURNS the number of QUEUE ROWS RELEASED, not price rows written. The filler's
  batch loop keys on this count, so a batch of already-current templates must
  still report its released rows or burn-down caps at one batch per interval. A
  row re-enqueued mid-batch has a bumped seq, survives the release, is not
  counted, and is claimed next cycle.

  DROP by bare name, not by the parenthesized zero-argument signature: on the
  test-database replay the function already exists in its one-argument form, the
  zero-argument DROP would be a no-op, and the CREATE would fail with 42723.
*/
DROP FUNCTION IF EXISTS update_atomicmarket_template_prices;
CREATE OR REPLACE FUNCTION update_atomicmarket_template_prices(batch_size INT DEFAULT 200) RETURNS INT
LANGUAGE plpgsql
AS $$
DECLARE
    rec RECORD;
    released INT := 0;
    current_block_time BIGINT = (SELECT MAX(block_time) FROM contract_readers);
BEGIN
    -- Any overlapping drain is a clean no-op. Transaction-scoped, so it releases
    -- between batches, and re-entrant within a transaction, so calling the
    -- function twice in one transaction (tests, manual burn-downs) still works.
    IF NOT pg_try_advisory_xact_lock(hashtext('update_atomicmarket_template_prices')) THEN
        RETURN 0;
    END IF;

    -- Plain temp table (not ON COMMIT DROP), explicitly dropped before RETURN, so
    -- the function is safe to call repeatedly on the reused longRunningPool
    -- connection and within a single test transaction. An error anywhere below
    -- rolls the CREATE back with everything else.
    CREATE TEMPORARY TABLE _tp_claimed (
        market_contract VARCHAR(12),
        assets_contract VARCHAR(12),
        template_id BIGINT,
        kind SMALLINT,
        seq BIGINT
    );

    -- CLAIM (no queue lock). Aging rows become visible only once their boundary
    -- has passed the reader's block time; live rows carry refresh_at 0 and are
    -- always due. ORDER BY prio, seq drains the real-time lane first, FIFO within
    -- a lane, and makes the batch deterministic.
    INSERT INTO _tp_claimed
        SELECT market_contract, assets_contract, template_id, kind, seq
        FROM atomicmarket_template_prices_updates
        WHERE refresh_at <= current_block_time
        ORDER BY prio, seq
        LIMIT batch_size;

    FOR rec IN
        WITH templates AS MATERIALIZED (
            SELECT DISTINCT template_id, assets_contract
            FROM _tp_claimed
            WHERE template_id IS NOT NULL
        ), sales AS MATERIALIZED (
            SELECT assets_contract, SUBSTRING(f FROM 2)::BIGINT template_id, MIN(price) min_price
            FROM atomicmarket_sales_filters_listed
                JOIN LATERAL UNNEST(filter) u(f) ON u.f LIKE 't%'
            WHERE seller_contract IS DISTINCT FROM TRUE
                AND asset_count = 1
        	    AND updated_at_time + 0 <= (current_block_time - 3600 * 24 * 3 * 1000) -- only include sales older than 3 days
                -- Batch-scoped GIN probe: only the claimed templates' listings.
                AND filter && (SELECT create_atomicmarket_sales_filter(template_ids := ARRAY_AGG(DISTINCT t.template_id)) FROM templates t)
            GROUP BY template_id, assets_contract
        )
        SELECT template_id, assets_contract, sug.suggested_median, sug.suggested_average, sug.input_count
        FROM templates
            LEFT OUTER JOIN sales USING (template_id, assets_contract)
            CROSS JOIN LATERAL (
                SELECT
                    LEAST(PERCENTILE_DISC(0.5) WITHIN GROUP (ORDER BY price), sales.min_price) suggested_median,
                    LEAST(AVG(price)::BIGINT, sales.min_price) suggested_average,
                    COUNT(*) input_count
                FROM (
                        (
                            SELECT listing_id /* not used, but required to prevent the same price being discarded in the union*/, price
                            FROM atomicmarket_stats_prices_master
                            WHERE template_id = templates.template_id AND assets_contract = templates.assets_contract
                                AND time >= ((extract(epoch from now() - '3 days'::INTERVAL)) * 1000)::BIGINT
                        )
                        UNION
                        (
                            SELECT listing_id, price
                            FROM atomicmarket_stats_prices_master
                            WHERE template_id = templates.template_id AND assets_contract = templates.assets_contract
                            ORDER BY time DESC
                            LIMIT 5
                        )
                    ) prices
            ) sug
	LOOP
        -- Authoritative: no inputs left means the price rows are stale, not absent.
        IF rec.input_count = 0 THEN
            DELETE FROM atomicmarket_template_prices
            WHERE template_id = rec.template_id AND assets_contract = rec.assets_contract;
            CONTINUE;
        END IF;

		INSERT INTO atomicmarket_template_prices AS tp (market_contract, assets_contract, collection_name, template_id, symbol,
    			median, average, suggested_median, suggested_average, "min", "max", sales)
			SELECT
				market_contract, assets_contract, collection_name, template_id, symbol,
				PERCENTILE_DISC(0.5) WITHIN GROUP (ORDER BY price) median,
				AVG(price)::bigint average,
				rec.suggested_median,
				rec.suggested_average,
				MIN(price) "min", MAX(price) "max", COUNT(*) sales
			FROM atomicmarket_stats_prices_master
			WHERE template_id = rec.template_id AND assets_contract = rec.assets_contract
			GROUP BY market_contract, assets_contract, collection_name, template_id, symbol
		ON CONFLICT (market_contract, assets_contract, collection_name, template_id, symbol)
			DO UPDATE SET
				median = EXCLUDED.median,
				average = EXCLUDED.average,
				suggested_median = EXCLUDED.suggested_median,
				suggested_average = EXCLUDED.suggested_average,
				"min" = EXCLUDED."min",
				"max" = EXCLUDED."max",
				sales = EXCLUDED.sales
			WHERE tp.median IS DISTINCT FROM EXCLUDED.median
				OR tp.average IS DISTINCT FROM EXCLUDED.average
				OR tp.suggested_median IS DISTINCT FROM EXCLUDED.suggested_median
				OR tp."min" IS DISTINCT FROM EXCLUDED."min"
				OR tp."max" IS DISTINCT FROM EXCLUDED."max"
				OR tp.sales IS DISTINCT FROM EXCLUDED.sales
		;
	END LOOP;

    -- COMPUTE the next boundary per claimed key, into a temp table, BEFORE the
    -- release. The write ordering below (release, then arm) is what keeps the
    -- arm off a stale past boundary; this compute ordering is what keeps the
    -- scans it needs out of the release's lock window. The release DELETE holds
    -- row locks on every queue row it removes until COMMIT, and a trigger
    -- enqueue targeting one of those keys XactLockTableWaits on this
    -- transaction, so any work between the DELETE and COMMIT is time the block
    -- writer can spend blocked, scaling with batch_size. The GIN probe over the
    -- listed partition and the per-template LATERAL probes are that work, so
    -- they run here, while no queue row is locked, and the arm itself becomes a
    -- read of this temp table.
    --
    -- Moving the compute earlier cannot change its result: it reads only
    -- atomicmarket_sales_filters_listed and atomicmarket_stats_prices_master,
    -- and the release touches neither.
    --
    -- Both boundary predicates are written `column > block_time - 3d` rather
    -- than `column + 3d > block_time` so the range stays index-sargable. The
    -- recompute's `+ 0` above is the opposite intent, an index suppression the
    -- expression carries verbatim from 1.3.14.
    CREATE TEMPORARY TABLE _tp_arm AS
    WITH claimed AS (
        SELECT DISTINCT market_contract, assets_contract, template_id
        FROM _tp_claimed
    ), armed_templates AS (
        SELECT DISTINCT assets_contract, template_id
        FROM claimed
    ), listing_boundaries AS (
        -- Next listing to cross INTO the cap window.
        SELECT l.assets_contract, SUBSTRING(f FROM 2)::BIGINT template_id,
               MIN(l.updated_at_time) + 3600 * 24 * 3 * 1000 AS boundary
        FROM atomicmarket_sales_filters_listed l
            JOIN LATERAL UNNEST(l.filter) u(f) ON u.f LIKE 't%'
        WHERE l.seller_contract IS DISTINCT FROM TRUE
            AND l.asset_count = 1
            AND l.updated_at_time > current_block_time - 3600 * 24 * 3 * 1000
            AND l.filter && (SELECT create_atomicmarket_sales_filter(template_ids := ARRAY_AGG(DISTINCT t.template_id)) FROM armed_templates t)
        GROUP BY 1, 2
    ), sale_boundaries AS (
        -- Next sale to drop OUT of the recent-sale window. LATERAL per template
        -- so each probe is an ordered index scan on (template_id, time) rather
        -- than a semi-join scan of the whole stats table.
        SELECT t.assets_contract, t.template_id, b.boundary
        FROM armed_templates t
            CROSS JOIN LATERAL (
                SELECT MIN(s."time") + 3600 * 24 * 3 * 1000 AS boundary
                FROM atomicmarket_stats_prices_master s
                WHERE s.template_id = t.template_id
                    AND s.assets_contract = t.assets_contract
                    AND s."time" > current_block_time - 3600 * 24 * 3 * 1000
            ) b
    )
    SELECT c.market_contract, c.assets_contract, c.template_id,
           LEAST(lb.boundary, sb.boundary) AS refresh_at
    FROM claimed c
        LEFT OUTER JOIN listing_boundaries lb USING (assets_contract, template_id)
        LEFT OUTER JOIN sale_boundaries sb USING (assets_contract, template_id)
    WHERE LEAST(lb.boundary, sb.boundary) IS NOT NULL;

    -- RELEASE: the only place the queue is locked, and from here to COMMIT the
    -- transaction does nothing but two temp-table reads and one queue write.
    -- Delete the claimed rows whose seq is unchanged since the claim; a row
    -- re-enqueued mid-batch has a higher seq and is left for the next batch.
    DELETE FROM atomicmarket_template_prices_updates q
        USING _tp_claimed c
        WHERE q.market_contract = c.market_contract
            AND q.assets_contract = c.assets_contract
            AND q.template_id = c.template_id
            AND q.kind = c.kind
            AND q.seq = c.seq;
    GET DIAGNOSTICS released = ROW_COUNT;

    -- ARM: one row per claimed key that has a future boundary, from the
    -- precomputed set alone. After the release, so it writes onto a cleared key
    -- rather than colliding with the stale past boundary it just consumed.
    INSERT INTO atomicmarket_template_prices_updates AS q (market_contract, assets_contract, template_id, kind, prio, refresh_at)
        SELECT a.market_contract, a.assets_contract, a.template_id, 1, 1, a.refresh_at
        FROM _tp_arm a
    ON CONFLICT (market_contract, assets_contract, template_id, kind)
        -- Earliest pending boundary wins. Defensive: the drain is single-flight
        -- and the only writer of kind 1, and the release above already removed
        -- the row this arm replaces.
        DO UPDATE SET refresh_at = LEAST(q.refresh_at, EXCLUDED.refresh_at),
                      seq = nextval('atomicmarket_template_prices_updates_seq');

    DROP TABLE _tp_claimed, _tp_arm;

    RETURN released;
END
$$;

-- The cutover seed is 2.0.7/atomicmarket.sql, deliberately not another
-- statement here: this transaction holds ACCESS EXCLUSIVE on
-- atomicmarket_stats_markets and atomicmarket_sales_filters_listed from the
-- DROP TRIGGER statements above until it commits, and every API reader of those
-- tables queues behind that. See database.sql for the full rationale, including
-- why seeding first inside one version is not the alternative.
