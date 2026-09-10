/*
  2.0.10 - Bounded, queue-driven update_atomicmarket_stats_market()
  (see database.sql for the version bump).

  THE SHAPE THIS AVOIDS
  The 1.3.15 recompute is one statement that DELETE-claims EVERY due row of
  atomicmarket_stats_markets_updates and resolves all four listing types in the
  same CTE chain. The filler called it on the default runtime pool, whose
  connection-level statement_timeout is 30s and, under PgBouncer transaction
  pooling, is the only timeout that applies. Against a backlog larger than 30s
  of work the statement is cancelled (57014), the DELETE-claim rolls back with
  it, and the next tick re-reads the same backlog and fails the same way. The
  queue only grows from there, so the failure is self-sustaining rather than
  self-healing: an operator sees the cancellation on every tick and the stats
  tables stop advancing altogether. A backlog large enough to enter that state
  needs no storm to build. The reader-lag gate skips the job entirely while the
  reader catches up, so a restart or a reindex accumulates one, and the queue
  had no dedup, so every re-enqueue of an already-queued listing added a row.

  THE SHAPE HERE
  The queue drives the recompute in bounded batches. The driving set is the
  listings claimed in the batch, and the resolution of a claimed listing carries
  1.3.23's CTE chain verbatim, so every written atomicmarket_stats_markets row
  is byte-identical to what the full recompute produces at the same point in
  time. Bounding is what makes the timeout survivable: a batch is sized to run
  in seconds, and the filler raises statement_timeout per batch through
  SET LOCAL on its own long-running pool rather than relying on the pool default.

  QUEUE PROTOCOL (the 1.7.11/1.7.13 protocol, as adopted for template prices in
  2.0.6)
  * Dedup on (market_contract, listing_type, listing_id, refresh_at). The queue
    had no unique index at all, so a hot listing added one row per write and the
    claim scanned all of them.
  * Claim without locks: the drain SELECTs its batch into a temp table,
    recomputes, and only then DELETEs the claimed rows guarded on the captured
    seq. A row re-enqueued mid-batch carries a bumped seq, survives the release
    and is recomputed next cycle. Nothing the block writer does waits on a
    claimed row, which is the whole point of the 1.7.11 rewrite and the
    difference from the DELETE-claim this replaces: that claim locked every due
    row for the entire recompute, so a block writer enqueuing any of them waited
    out the whole run.
  * One xact-scoped advisory try-lock makes any overlapping drain a clean no-op.
    Correctness under interleaved drains comes from the guarded release, not the
    lock.
  * seq is deliberately NOT indexed, for 1.7.13's reason: the claim is a seqscan
    plus top-N sort, and keeping seq out of every index keeps the hot ON CONFLICT
    bumps HOT-updatable inside the fillfactor 70 free space. The escape hatch, if
    a residual backlog makes the per-batch seqscan visible, is a partial index via
    a later atomicmarket-deferred.sql.

  WHY THE DEDUP KEY CARRIES refresh_at, AND WHY THERE IS NO kind COLUMN
  An auction is a stats row only once its end_time has passed, so the auction
  trigger enqueues twice: an immediate row at refresh_at 0 and a future row at
  end_time * 1000, claimable only once the reader's block time crosses it. Both
  rows carry the same listing key, so a three-column key would collapse them and
  the drain would either recompute the auction too early or never revisit it.
  Carrying refresh_at in the key keeps them distinct without a kind column, and
  it also keeps successive boundaries distinct: a bid that extends end_time adds
  a row at the new boundary rather than overwriting the old one, so a queue that
  already holds the earlier boundary still visits it. Depth per listing is
  therefore 1 + the number of distinct pending end_times, which is 2 or 3 in
  practice and was unbounded before.

  This differs from 2.0.6's aging rows deliberately. There the drain arms the
  boundary itself, because a template has several pending boundaries and one
  aging row cannot carry them all. A listing has exactly one boundary, written
  by the trigger that knows it, so no arm step is needed here and the drain
  writes nothing back to its own queue.

  THE REBUILD, AND WHY NOT ALTER
  The queue is recreated rather than altered. ADD COLUMN seq with a nextval
  default rewrites the heap anyway; the rows that need deduplicating cannot be
  deduplicated without a self-join over a heap that has no key to join on; and a
  queue that has run without absolute autovacuum thresholds since 1.3.13 carries
  bloat that only a rewrite reclaims. One CREATE, one INSERT SELECT DISTINCT, one
  DROP and one RENAME does all three in a single pass, under one ACCESS EXCLUSIVE
  lock on the queue alone, taken before the copy reads a row. Nothing but the
  filler reads or writes that table, so the lock blocks no API reader. The four
  enqueue functions resolve the table name at call time, so the DROP and RENAME
  leave them working.

  The lock is also the deploy precondition. A filler already processing blocks
  holds row locks on this queue for the length of one 1.3.15 recompute, and a
  large backlog, the state this version exists to fix, is where that recompute
  runs longest. The version then fails on the 5s lock_timeout and retries on the
  next boot, which is the safe outcome and not the intended one: stop the running
  filler before starting one on this version.

  Rows with a NULL market_contract or listing_id are dropped by the rebuild and
  the columns are made NOT NULL. Such a row can never match a listing, so it was
  already dead weight; under the guarded release it would be worse than dead,
  because the release compares the claimed columns for equality and NULL never
  equals NULL, so the row would be claimed on every batch and released by none.
  The triggers have always supplied both columns, so the rebuild is expected to
  drop nothing.

  LOCK ORDER
  The recompute writes atomicmarket_stats_markets, which fires 2.0.6's
  update_atomicmarket_template_prices_by_stats_markets and takes row locks in
  atomicmarket_template_prices_updates; the release then takes row locks in
  atomicmarket_stats_markets_updates. That is the reverse of the order a
  transaction would take them in if it enqueued a listing first and a template
  second, so it is worth stating why no such transaction exists. The block
  writer enqueues into atomicmarket_stats_markets_updates and
  atomicmarket_sales_filters_updates and touches the template-prices queue
  through neither: atomicmarket_sales_filters_listed, the other table whose
  trigger writes that queue, is written only by update_atomicmarket_sales_filters
  itself. Both that drain and the template-prices drain draw the same max-1
  longRunningPool client this one runs on, so none of the three overlaps another.
  Keep the release last and add nothing after it.

  One transaction does take the two queues in the opposite order:
  AtomicMarketHandler.deleteDB, which clears a handler's rows before a reindex.
  It deletes the market tables first, firing the enqueue triggers below, and
  atomicmarket_stats_markets after, firing 2.0.6's. Within a filler it runs at
  boot and the job queue starts later, so the two never interleave. Across two
  fillers sharing a database they could, which is one more reason the deployment
  runs one filler per chain.

  RETURNS the number of QUEUE ROWS RELEASED, where 1.3.15 returned the number of
  stats rows written. The filler's batch loop keys on this count, so a batch of
  already-current listings must still report its released rows or burn-down caps
  at one batch per interval. Nothing reads the old return value.

  ROLLBACK
  The zero-argument call update_atomicmarket_stats_market() resolves through the
  parameter default, so an image at an earlier tag calling it on that tag's two
  minute cadence drains correctly, one default batch at a time, on the default
  pool. That rate is far below a backlog's inflow, so a sustained rollback trades
  the stall fix for growing staleness; it is the escape from a broken image, not
  a steady state. The queue and triggers stay in the database and need no schema
  rollback.

  REPLAY
  Fresh installs and the test database replay every migration unconditionally
  (src/bin/init-test-db.ts), so every statement here is idempotent: the rebuild
  is guarded on the column it adds, table and index creation are guarded, the
  trigger functions are CREATE OR REPLACE and their triggers are left alone, and
  the one signature change uses a name-only DROP FUNCTION (the parenthesized
  zero-argument form would not match the new one-argument function on a second
  pass, and the CREATE would then fail with 42723).
*/

-- Repeated from database.sql for legibility; both files run in one transaction,
-- so the LOCAL settings would carry over anyway.
SET LOCAL statement_timeout = 0;
SET LOCAL lock_timeout = '5s';


-- Monotonic claim/release version token. Gaps are fine (a conflicting INSERT
-- still consumes a value). Created before the table so the column DEFAULT can
-- reference it.
CREATE SEQUENCE IF NOT EXISTS atomicmarket_stats_markets_updates_seq;

-- Rebuild rather than ALTER, and drop the unkeyable rows: see THE REBUILD in the
-- header. Guarded on the column it adds, so a replay is a no-op. ORDER BY is
-- best-effort FIFO: the old rows carry no arrival order to preserve, and nothing
-- depends on the claim order for correctness.
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
            AND table_name = 'atomicmarket_stats_markets_updates'
            AND column_name = 'seq'
    ) THEN
        -- Take the lock the DROP needs BEFORE reading the table, not when the
        -- DROP asks for it. A copy that runs under ACCESS SHARE reads its own
        -- snapshot, and an enqueue another backend commits between that snapshot
        -- and the DROP's lock is dropped with the old heap: a listing whose stats
        -- row never recomputes until something else touches it, with no error and
        -- no trace. Holding one lock across the copy and the drop closes that
        -- window. It also means the version fails rather than corrupts when a
        -- second filler still writes the queue, which is what the 5s lock_timeout
        -- turns into a clean abort and a retry on the next boot.
        LOCK TABLE atomicmarket_stats_markets_updates IN ACCESS EXCLUSIVE MODE;

        CREATE TABLE atomicmarket_stats_markets_updates_new (
            market_contract VARCHAR(12) NOT NULL,
            listing_type TEXT NOT NULL,
            listing_id BIGINT NOT NULL,
            -- Epoch milliseconds, the same unit as contract_readers.block_time.
            -- Immediate rows keep 0 so they are always claimable; an auction's
            -- boundary row carries end_time * 1000.
            refresh_at BIGINT NOT NULL DEFAULT 0,
            seq BIGINT NOT NULL DEFAULT nextval('atomicmarket_stats_markets_updates_seq')
        );

        INSERT INTO atomicmarket_stats_markets_updates_new (market_contract, listing_type, listing_id, refresh_at)
            SELECT DISTINCT market_contract, listing_type, listing_id, refresh_at
            FROM atomicmarket_stats_markets_updates
            WHERE market_contract IS NOT NULL
                AND listing_type IS NOT NULL
                AND listing_id IS NOT NULL
            ORDER BY refresh_at;

        DROP TABLE atomicmarket_stats_markets_updates;
        ALTER TABLE atomicmarket_stats_markets_updates_new RENAME TO atomicmarket_stats_markets_updates;
    END IF;
END $$;

-- Tie the sequence lifecycle to the column so it is dropped with the table (no
-- orphaned sequence on a future recreate). OWNED BY does not affect the DEFAULT.
ALTER SEQUENCE atomicmarket_stats_markets_updates_seq
    OWNED BY atomicmarket_stats_markets_updates.seq;

-- Storage tuning matching the 1.7.11 sales-filter queue and the 2.0.6
-- template-prices queue, whose header names this table as the sibling that
-- lacked it. Every re-enqueue of an already-queued key is now a DO UPDATE and so
-- writes a dead tuple on the hot block-write path; the live row count is small,
-- so the default scale-factor autovacuum would almost never fire. Absolute
-- thresholds reclaim those tuples, and fillfactor 70 keeps the updates HOT
-- (in-page), which is what keeps them from spawning index entries.
ALTER TABLE atomicmarket_stats_markets_updates SET (
    autovacuum_vacuum_scale_factor = 0.0,
    autovacuum_vacuum_threshold = 1000,
    autovacuum_vacuum_insert_scale_factor = 0.0,
    autovacuum_vacuum_insert_threshold = 1000,
    fillfactor = 70
);

-- Dedup key, and the ON CONFLICT arbiter for every enqueue below. Not
-- CONCURRENTLY: the runner wraps the version in a transaction, and after the
-- rebuild there is nothing to build against.
CREATE UNIQUE INDEX IF NOT EXISTS atomicmarket_stats_markets_updates_key
    ON atomicmarket_stats_markets_updates (market_contract, listing_type, listing_id, refresh_at);


/*
  The four enqueue functions, replaced in place to route every INSERT through the
  new dedup key. CREATE OR REPLACE only: the triggers themselves already point at
  these names and are left untouched, so this version takes no lock on
  atomicmarket_sales, atomicmarket_auctions, atomicmarket_buyoffers or
  atomicmarket_template_buyoffers, all of which the API reads. The 1.3.13 and
  1.3.23 versions of these functions drop the function CASCADE and recreate the
  trigger; that is what a version must not do to a live market table when it has
  no reason to.

  DO UPDATE SET seq, not DO NOTHING: the bumped seq is what makes a re-enqueue
  arriving between a drain's claim and its release survive the guarded release
  and be recomputed next cycle. DO NOTHING would let the release delete a row
  whose listing changed after the claim read it, and the change would be lost
  until something else touched the same listing.
*/
CREATE OR REPLACE FUNCTION update_atomicmarket_stats_markets_by_sale() RETURNS TRIGGER AS $$
DECLARE
    affects_stats_markets BOOLEAN;
BEGIN
    affects_stats_markets =
        (TG_OP IN ('INSERT', 'UPDATE') AND NEW.final_price IS NOT NULL AND NEW.state = 3)
        OR
        (TG_OP IN ('DELETE', 'UPDATE') AND OLD.final_price IS NOT NULL AND OLD.state = 3);
    IF (NOT affects_stats_markets)
    THEN RETURN NULL;
    END IF;

    INSERT INTO atomicmarket_stats_markets_updates(market_contract, listing_type, listing_id)
    VALUES (
        CASE TG_OP WHEN 'DELETE' THEN OLD.market_contract ELSE NEW.market_contract END,
        'sale',
        CASE TG_OP WHEN 'DELETE' THEN OLD.sale_id ELSE NEW.sale_id END
    )
    ON CONFLICT (market_contract, listing_type, listing_id, refresh_at)
        DO UPDATE SET seq = nextval('atomicmarket_stats_markets_updates_seq');

    RETURN NULL;
END
$$ LANGUAGE plpgsql;


/*
  The auction enqueues twice, and both rows matter: see WHY THE DEDUP KEY CARRIES
  refresh_at in the header. The two INSERTs are separate statements, so an auction
  whose end_time is 0 collapses onto one row through the second statement's
  ON CONFLICT rather than raising 21000.
*/
CREATE OR REPLACE FUNCTION update_atomicmarket_stats_markets_by_auction() RETURNS TRIGGER AS $$
DECLARE
    affects_stats_markets BOOLEAN;
BEGIN
    affects_stats_markets =
        (TG_OP IN ('INSERT', 'UPDATE') AND NEW.buyer IS NOT NULL AND NEW.state = 1)
        OR
        (TG_OP IN ('DELETE', 'UPDATE') AND OLD.buyer IS NOT NULL AND OLD.state = 1);
    IF (NOT affects_stats_markets)
    THEN RETURN NULL;
    END IF;

    INSERT INTO atomicmarket_stats_markets_updates(market_contract, listing_type, listing_id)
    VALUES (
        CASE TG_OP WHEN 'DELETE' THEN OLD.market_contract ELSE NEW.market_contract END,
        'auction',
        CASE TG_OP WHEN 'DELETE' THEN OLD.auction_id ELSE NEW.auction_id END
    )
    ON CONFLICT (market_contract, listing_type, listing_id, refresh_at)
        DO UPDATE SET seq = nextval('atomicmarket_stats_markets_updates_seq');

    IF (TG_OP IN ('INSERT', 'UPDATE'))
    THEN
		INSERT INTO atomicmarket_stats_markets_updates(market_contract, listing_type, listing_id, refresh_at)
		VALUES (
			NEW.market_contract,
			'auction',
			NEW.auction_id,
			NEW.end_time * 1000
		)
		ON CONFLICT (market_contract, listing_type, listing_id, refresh_at)
		    DO UPDATE SET seq = nextval('atomicmarket_stats_markets_updates_seq');
    END IF;

    RETURN NULL;
END
$$ LANGUAGE plpgsql;


CREATE OR REPLACE FUNCTION update_atomicmarket_stats_markets_by_buyoffer() RETURNS TRIGGER AS $$
DECLARE
    affects_stats_markets BOOLEAN;
BEGIN
    affects_stats_markets =
        (TG_OP IN ('INSERT', 'UPDATE') AND NEW.state = 3)
        OR
        (TG_OP IN ('DELETE', 'UPDATE') AND OLD.state = 3);
    IF (NOT affects_stats_markets)
    THEN RETURN NULL;
    END IF;

    INSERT INTO atomicmarket_stats_markets_updates(market_contract, listing_type, listing_id)
    VALUES (
        CASE TG_OP WHEN 'DELETE' THEN OLD.market_contract ELSE NEW.market_contract END,
        'buyoffer',
        CASE TG_OP WHEN 'DELETE' THEN OLD.buyoffer_id ELSE NEW.buyoffer_id END
    )
    ON CONFLICT (market_contract, listing_type, listing_id, refresh_at)
        DO UPDATE SET seq = nextval('atomicmarket_stats_markets_updates_seq');

    RETURN NULL;
END
$$ LANGUAGE plpgsql;


CREATE OR REPLACE FUNCTION update_atomicmarket_stats_markets_by_template_buyoffer() RETURNS TRIGGER AS $$
DECLARE
    affects_stats_markets BOOLEAN;
BEGIN
    affects_stats_markets =
        (TG_OP IN ('INSERT', 'UPDATE') AND NEW.state = 2)
        OR
        (TG_OP IN ('DELETE', 'UPDATE') AND OLD.state = 2);
    IF (NOT affects_stats_markets)
    THEN RETURN NULL;
    END IF;

    INSERT INTO atomicmarket_stats_markets_updates(market_contract, listing_type, listing_id)
    VALUES (
        CASE TG_OP WHEN 'DELETE' THEN OLD.market_contract ELSE NEW.market_contract END,
        'template_buyoffer',
        CASE TG_OP WHEN 'DELETE' THEN OLD.buyoffer_id ELSE NEW.buyoffer_id END
    )
    ON CONFLICT (market_contract, listing_type, listing_id, refresh_at)
        DO UPDATE SET seq = nextval('atomicmarket_stats_markets_updates_seq');

    RETURN NULL;
END
$$ LANGUAGE plpgsql;


/*
  The bounded drain.

  * CLAIM into a temp table, no queue lock, ORDER BY seq for FIFO and a
    deterministic batch. Due-ness is measured against the reader's block time,
    never wall clock: on a lagging filler the two diverge by the lag, and a
    wall-clock gate would claim an auction boundary row the recompute will not
    resolve yet and spin on it every batch.
  * RECOMPUTE carries 1.3.23's CTE chain verbatim, with the claimed set in place
    of the DELETE-claim it replaces. The wall-clock predicate on the auction arm
    (`end_time < extract(epoch from now())`) is kept exactly as it was, because
    output parity with the full recompute is the contract. Block time never runs
    ahead of wall clock, so a boundary row that has become claimable has always
    also passed that predicate.
  * RELEASE last, guarded on the captured seq, and nothing after it. See LOCK
    ORDER and QUEUE PROTOCOL in the header.

  DROP by bare name, not by the parenthesized zero-argument signature: on the
  test-database replay the function already exists in its one-argument form, the
  zero-argument DROP would be a no-op, and the CREATE would fail with 42723.
*/
DROP FUNCTION IF EXISTS update_atomicmarket_stats_market;
CREATE OR REPLACE FUNCTION update_atomicmarket_stats_market(batch_size INT DEFAULT 1000) RETURNS INT
LANGUAGE plpgsql
AS $$
DECLARE
    -- Assigned only to give the recompute statement a target. The data-modifying
    -- CTEs run whether or not the final SELECT reads them, and the count of stats
    -- rows written is deliberately not what this function returns (see the header).
    written INT;
    released INT := 0;
    current_block_time BIGINT = (SELECT MAX(block_time) FROM contract_readers);
BEGIN
    -- Any overlapping drain is a clean no-op. Transaction-scoped, so it releases
    -- between batches, and re-entrant within a transaction, so calling the
    -- function twice in one transaction (tests, manual burn-downs) still works.
    IF NOT pg_try_advisory_xact_lock(hashtext('update_atomicmarket_stats_market')) THEN
        RETURN 0;
    END IF;

    -- Plain temp table (not ON COMMIT DROP), explicitly dropped before RETURN, so
    -- the function is safe to call repeatedly on the reused longRunningPool
    -- connection and within a single test transaction. An error anywhere below
    -- rolls the CREATE back with everything else.
    CREATE TEMPORARY TABLE _sm_claimed (
        market_contract VARCHAR(12),
        listing_type TEXT,
        listing_id BIGINT,
        refresh_at BIGINT,
        seq BIGINT
    );

    -- CLAIM (no queue lock).
    INSERT INTO _sm_claimed
        SELECT market_contract, listing_type, listing_id, refresh_at, seq
        FROM atomicmarket_stats_markets_updates
        WHERE refresh_at <= current_block_time
        ORDER BY seq
        LIMIT batch_size;

    -- The claimed set drives four semi-joins against the largest tables in the
    -- schema, and a temp table carries no statistics until it is analysed, so
    -- without this the planner sizes the driving set from a built-in default.
    -- A bad enough estimate flips a driven index scan to a sequential one and
    -- the batch runs past its timeout, which is the failure this version exists
    -- to remove. Analysing at most batch_size rows costs microseconds. 2.0.6
    -- does not do this for its own claim; it carries the same exposure.
    ANALYZE _sm_claimed;

    WITH updated_listings AS (
        SELECT
            sale.market_contract, 'sale' listing_type, sale.sale_id listing_id,
            sale.buyer, sale.seller, sale.maker_marketplace, sale.taker_marketplace,
            sale.assets_contract, sale.collection_name,
            sale.settlement_symbol symbol, sale.final_price price, sale.updated_at_time "time",
            CASE WHEN COUNT(*) = 1 THEN MIN(asset.schema_name) END AS schema_name,
            CASE WHEN COUNT(*) = 1 THEN MIN(asset.template_id) END AS template_id,
            CASE WHEN COUNT(*) = 1 THEN MIN(asset.asset_id) END AS asset_id
        FROM atomicmarket_sales sale
            JOIN atomicassets_offers_assets offer_asset ON sale.offer_id = offer_asset.offer_id AND sale.assets_contract = offer_asset.contract
            JOIN atomicassets_assets asset ON offer_asset.asset_id = asset.asset_id AND offer_asset.contract = asset.contract
        WHERE sale.final_price IS NOT NULL AND sale.state = 3
            AND (sale.market_contract, sale.sale_id) IN (
                SELECT market_contract, listing_id
                FROM _sm_claimed
                WHERE listing_type = 'sale'
            )
        GROUP BY sale.market_contract, sale.sale_id

        UNION ALL

        SELECT
            auction.market_contract, 'auction' listing_type, auction.auction_id listing_id,
            auction.buyer, auction.seller, auction.maker_marketplace, auction.taker_marketplace,
            auction.assets_contract, auction.collection_name,
            auction.token_symbol symbol, auction.price, (auction.end_time * 1000) "time",
            CASE WHEN COUNT(*) = 1 THEN MIN(asset.schema_name) END AS schema_name,
            CASE WHEN COUNT(*) = 1 THEN MIN(asset.template_id) END AS template_id,
            CASE WHEN COUNT(*) = 1 THEN MIN(asset.asset_id) END AS asset_id
        FROM atomicmarket_auctions auction
            JOIN atomicmarket_auctions_assets auction_asset ON auction.auction_id = auction_asset.auction_id AND auction.assets_contract = auction_asset.assets_contract
            JOIN atomicassets_assets asset ON auction_asset.asset_id = asset.asset_id AND auction_asset.assets_contract = asset.contract
        WHERE auction.buyer IS NOT NULL AND auction.state = 1 AND auction.end_time < extract(epoch from now())
            AND (auction.market_contract, auction.auction_id) IN (
                SELECT market_contract, listing_id
                FROM _sm_claimed
                WHERE listing_type = 'auction'
            )
        GROUP BY auction.market_contract, auction.auction_id

        UNION ALL

        SELECT
            buyoffer.market_contract, 'buyoffer' listing_type, buyoffer.buyoffer_id listing_id,
            buyoffer.buyer, buyoffer.seller, buyoffer.maker_marketplace, buyoffer.taker_marketplace,
            buyoffer.assets_contract, buyoffer.collection_name,
            buyoffer.token_symbol symbol, buyoffer.price, buyoffer.updated_at_time "time",
            CASE WHEN COUNT(*) = 1 THEN MIN(asset.schema_name) END AS schema_name,
            CASE WHEN COUNT(*) = 1 THEN MIN(asset.template_id) END AS template_id,
            CASE WHEN COUNT(*) = 1 THEN MIN(asset.asset_id) END AS asset_id
        FROM atomicmarket_buyoffers buyoffer
            JOIN atomicmarket_buyoffers_assets buyoffer_asset ON buyoffer.buyoffer_id = buyoffer_asset.buyoffer_id AND buyoffer.assets_contract = buyoffer_asset.assets_contract
            JOIN atomicassets_assets asset ON buyoffer_asset.asset_id = asset.asset_id AND buyoffer_asset.assets_contract = asset.contract
        WHERE buyoffer.state = 3
            AND (buyoffer.market_contract, buyoffer.buyoffer_id) IN (
                SELECT market_contract, listing_id
                FROM _sm_claimed
                WHERE listing_type = 'buyoffer'
            )
        GROUP BY buyoffer.market_contract, buyoffer.buyoffer_id

        UNION ALL

        SELECT
            t_buyoffer.market_contract, 'template_buyoffer' listing_type, t_buyoffer.buyoffer_id listing_id,
            t_buyoffer.buyer, t_buyoffer.seller, t_buyoffer.maker_marketplace, t_buyoffer.taker_marketplace,
            t_buyoffer.assets_contract, t_buyoffer.collection_name,
            t_buyoffer.token_symbol symbol, t_buyoffer.price, t_buyoffer.updated_at_time "time",
            CASE WHEN COUNT(*) = 1 THEN MIN(asset.schema_name) END AS schema_name,
            t_buyoffer.template_id,
            CASE WHEN COUNT(*) = 1 THEN MIN(asset.asset_id) END AS asset_id
        FROM atomicmarket_template_buyoffers t_buyoffer
            JOIN atomicmarket_template_buyoffers_assets t_buyoffer_asset ON t_buyoffer.buyoffer_id = t_buyoffer_asset.buyoffer_id AND t_buyoffer.assets_contract = t_buyoffer_asset.assets_contract
            JOIN atomicassets_assets asset ON t_buyoffer_asset.asset_id = asset.asset_id AND t_buyoffer_asset.assets_contract = asset.contract
        WHERE t_buyoffer.state = 2
            AND (t_buyoffer.market_contract, t_buyoffer.buyoffer_id) IN (
                SELECT market_contract, listing_id
                FROM _sm_claimed
                WHERE listing_type = 'template_buyoffer'
            )
        GROUP BY t_buyoffer.market_contract, t_buyoffer.buyoffer_id
    ), ins_upd AS (
        INSERT INTO atomicmarket_stats_markets AS m (
            market_contract, listing_type, listing_id, buyer, seller,
            maker_marketplace, taker_marketplace, assets_contract,
            collection_name, symbol, price, "time",
            schema_name, template_id, asset_id
        )
            SELECT
                market_contract, listing_type, listing_id, buyer, seller,
                maker_marketplace, taker_marketplace, assets_contract,
                collection_name, symbol, price, "time",
                schema_name, template_id, asset_id
            FROM updated_listings
        ON CONFLICT (market_contract, listing_type, listing_id)
            DO UPDATE SET
                buyer = EXCLUDED.buyer,
                seller = EXCLUDED.seller,
                maker_marketplace = EXCLUDED.maker_marketplace,
                taker_marketplace = EXCLUDED.taker_marketplace,
                assets_contract = EXCLUDED.assets_contract,
                collection_name = EXCLUDED.collection_name,
                symbol = EXCLUDED.symbol,
                price = EXCLUDED.price,
                "time" = EXCLUDED."time",
                schema_name = EXCLUDED.schema_name,
                template_id = EXCLUDED.template_id,
                asset_id = EXCLUDED.asset_id
            WHERE
                m.buyer IS DISTINCT FROM EXCLUDED.buyer
                OR m.seller IS DISTINCT FROM EXCLUDED.seller
                OR m.price IS DISTINCT FROM EXCLUDED.price
                OR m.maker_marketplace IS DISTINCT FROM EXCLUDED.maker_marketplace
                OR m.taker_marketplace IS DISTINCT FROM EXCLUDED.taker_marketplace
                OR m.assets_contract IS DISTINCT FROM EXCLUDED.assets_contract
                OR m.collection_name IS DISTINCT FROM EXCLUDED.collection_name
                OR m.symbol IS DISTINCT FROM EXCLUDED.symbol
                OR m.price IS DISTINCT FROM EXCLUDED.price
                OR m."time" IS DISTINCT FROM EXCLUDED."time"
                OR m.schema_name IS DISTINCT FROM EXCLUDED.schema_name
                OR m.template_id IS DISTINCT FROM EXCLUDED.template_id
                OR m.asset_id IS DISTINCT FROM EXCLUDED.asset_id
        RETURNING market_contract, listing_type, listing_id
    ), del AS (
        DELETE FROM atomicmarket_stats_markets
        WHERE (market_contract, listing_type, listing_id) IN (
            SELECT market_contract, listing_type, listing_id FROM _sm_claimed
            EXCEPT
            SELECT market_contract, listing_type, listing_id FROM updated_listings
        )
        RETURNING 1
    )
    SELECT COALESCE((SELECT COUNT(*) FROM ins_upd), 0)
        + COALESCE((SELECT COUNT(*) FROM del), 0)
    INTO written;

    -- RELEASE: the only place the queue is locked, and from here to COMMIT the
    -- transaction does nothing but one temp-table read and one queue write.
    -- Delete the claimed rows whose seq is unchanged since the claim; a row
    -- re-enqueued mid-batch has a higher seq and is left for the next batch.
    DELETE FROM atomicmarket_stats_markets_updates q
        USING _sm_claimed c
        WHERE q.market_contract = c.market_contract
            AND q.listing_type = c.listing_type
            AND q.listing_id = c.listing_id
            AND q.refresh_at = c.refresh_at
            AND q.seq = c.seq;
    GET DIAGNOSTICS released = ROW_COUNT;

    DROP TABLE _sm_claimed;

    RETURN released;
END
$$;
