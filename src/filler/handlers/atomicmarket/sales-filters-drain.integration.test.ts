import 'mocha';
import { expect } from 'chai';
import { Client } from 'pg';

import { initAtomicMarketTest } from '../../../api/namespaces/atomicmarket/test';
import { getTestPostgresConfig } from '../../../utils/test';

// Integration coverage for the 1.7.11 queue-claim decoupling (version-guarded
// SELECT-then-DELETE-at-end). Runs against the test DB (which applies migration
// 1.7.11). The headline test is the two-connection concurrency case proving the
// reader's enqueue is NOT blocked by an in-flight drain and that a change racing
// the drain is NOT lost.
//
// All queue lookups scope to (asset_contract = 'aatest', asset_id): the real queue
// key is (asset_contract, asset_id), so filtering by asset_id alone could collide
// with another test's row that shares the asset_id.

const CONTRACT = 'aatest';

const ENQUEUE_ASSET = `
    INSERT INTO atomicmarket_sales_filters_updates(asset_contract, asset_id)
    VALUES ('${CONTRACT}', $1)
    ON CONFLICT (asset_contract, asset_id) WHERE asset_id IS NOT NULL
        DO UPDATE SET seq = nextval('atomicmarket_sales_filters_updates_seq'),
                      prio = 0`;

// Bulk-lane seed: same conflict action as refresh_atomicmarket_sales_filters_price
// (prio 1, LEAST = never downgrade) but keyable per test and usable for asset keys.
const ENQUEUE_ASSET_BULK = `
    INSERT INTO atomicmarket_sales_filters_updates(asset_contract, asset_id, prio)
    VALUES ('${CONTRACT}', $1, 1)
    ON CONFLICT (asset_contract, asset_id) WHERE asset_id IS NOT NULL
        DO UPDATE SET seq = nextval('atomicmarket_sales_filters_updates_seq'),
                      prio = LEAST(atomicmarket_sales_filters_updates.prio, 1::SMALLINT)`;

const MARKET = 'amtest';

const ENQUEUE_SALE = `
    INSERT INTO atomicmarket_sales_filters_updates(market_contract, sale_id)
    VALUES ('${MARKET}', $1)
    ON CONFLICT (market_contract, sale_id) WHERE sale_id IS NOT NULL
        DO UPDATE SET seq = nextval('atomicmarket_sales_filters_updates_seq'),
                      prio = 0`;

// Minimal variable-price listing row in atomicmarket_sales_filters — the set
// refresh_atomicmarket_sales_filters_price() bulk-enqueues from.
const SEED_VARIABLE_PRICE_LISTING = `
    INSERT INTO atomicmarket_sales_filters
        (sale_id, created_at_block, offer_id, updated_at_time, created_at_time,
         sale_state, market_contract, assets_contract, maker_marketplace, variable_price)
    VALUES ($1, 1, $1, 1, 1, 1, '${MARKET}', '${CONTRACT}', '', TRUE)`;

const { client, txit } = initAtomicMarketTest();

describe('update_atomicmarket_sales_filters — queue-claim decoupling (1.7.11)', () => {
    txit('drains a queued sale: queue emptied, filter row recomputed', async () => {
        const { sale_id } = await client.createFullSale();

        const before = await client.query<{ c: number }>(
            'SELECT count(*)::int c FROM atomicmarket_sales_filters_updates',
        );
        expect(before.rows[0].c, 'createFullSale should enqueue work').to.be.greaterThan(0);

        const removed = await client.query<{ removed: number }>(
            'SELECT update_atomicmarket_sales_filters(5000) AS removed',
        );
        expect(Number(removed.rows[0].removed), 'return value counts rows REMOVED').to.equal(before.rows[0].c);

        const queued = await client.query<{ c: number }>(
            'SELECT count(*)::int c FROM atomicmarket_sales_filters_updates',
        );
        expect(queued.rows[0].c, 'queue drained').to.equal(0);

        const filtered = await client.query<{ c: number }>(
            'SELECT count(*)::int c FROM atomicmarket_sales_filters WHERE sale_id = $1',
            [sale_id],
        );
        expect(filtered.rows[0].c, 'filter row recomputed').to.be.greaterThan(0);
    });

    txit('re-draining an unchanged queue is a clean no-op', async () => {
        await client.createFullSale();
        await client.query('SELECT update_atomicmarket_sales_filters(5000)');
        const consumed = await client.query<{ consumed: number }>(
            'SELECT update_atomicmarket_sales_filters(5000) AS consumed',
        );
        expect(Number(consumed.rows[0].consumed)).to.equal(0);
    });

    txit('re-enqueue bumps the seq version token', async () => {
        const read = `SELECT seq FROM atomicmarket_sales_filters_updates WHERE asset_contract = '${CONTRACT}' AND asset_id = $1`;
        await client.query(ENQUEUE_ASSET, [424242]);
        const s0 = (await client.query<{ seq: string }>(read, [424242])).rows[0].seq;
        await client.query(ENQUEUE_ASSET, [424242]);
        const s1 = (await client.query<{ seq: string }>(read, [424242])).rows[0].seq;
        expect(Number(s1)).to.be.greaterThan(Number(s0));
    });

    // Headline correctness test: needs two real connections (txit's single-txn model
    // cannot represent concurrent backends). Models the drain's three phases (CLAIM
    // select → [recompute window] → version-guarded end-DELETE) on one connection while
    // a reader enqueues on the other in the middle. The reader sets a small lock_timeout
    // so that IF its enqueue blocked on the drain txn (the old DELETE-at-start behavior)
    // it would deterministically ERROR rather than rely on wall-clock timing.
    it('reader enqueue is not blocked by an in-flight drain, and a racing change is not lost', async () => {
        const cfg = getTestPostgresConfig();
        const drain = new Client(cfg);
        const reader = new Client(cfg);
        const K = 987654321; // dedicated asset key, cleaned up in finally
        const where = `asset_contract = '${CONTRACT}' AND asset_id = $1`;
        try {
            await drain.connect();
            await reader.connect();
            await reader.query(`DELETE FROM atomicmarket_sales_filters_updates WHERE ${where}`, [K]);

            // Seed a queued change for key K.
            await reader.query(ENQUEUE_ASSET, [K]);

            // DRAIN phase 1 — CLAIM: SELECT (no lock), capture seq, hold the txn open
            // (stands in for the ~25s recompute, during which the real function also
            // holds no queue lock).
            await drain.query('BEGIN');
            const claimed = await drain.query<{ seq: string }>(
                `SELECT seq FROM atomicmarket_sales_filters_updates WHERE ${where} ORDER BY seq LIMIT 1`,
                [K],
            );
            const s0 = claimed.rows[0].seq;

            // READER — enqueue the SAME key while the drain txn is open. With a 2s
            // lock_timeout, the old DELETE-at-start design (ON CONFLICT speculative-wait
            // on the drain xid) would raise "canceling statement due to lock timeout";
            // the new SELECT-claim design takes no queue lock so this resolves at once.
            await reader.query("SET lock_timeout = '2s'");
            await reader.query(ENQUEUE_ASSET, [K]); // must NOT throw
            await reader.query('SET lock_timeout = 0');

            // DRAIN phase 3 — version-guarded end-DELETE keyed on the captured seq.
            const del = await drain.query(
                `DELETE FROM atomicmarket_sales_filters_updates WHERE ${where} AND seq = $2`,
                [K, s0],
            );
            await drain.query('COMMIT');
            expect(del.rowCount, 'stale-seq end-DELETE must skip the re-enqueued row').to.equal(0);

            // The racing change survives (bumped seq) → it will be reprocessed → not lost.
            const survive = await reader.query<{ c: number }>(
                `SELECT count(*)::int c FROM atomicmarket_sales_filters_updates WHERE ${where}`,
                [K],
            );
            expect(survive.rows[0].c, 'racing change must survive (no lost update)').to.equal(1);
        } finally {
            await reader
                .query(`DELETE FROM atomicmarket_sales_filters_updates WHERE ${where}`, [K])
                .catch(() => undefined);
            await drain.end().catch(() => undefined);
            await reader.end().catch(() => undefined);
        }
    });

    // A second concurrent drain must be a clean no-op (the SELECT-claim no longer mutually
    // excludes drains the way the old DELETE-claim did; the function takes a txn-scoped
    // advisory lock to restore that). Models an in-flight drain by holding the lock on one
    // connection while a real drain call runs on another.
    it('a second concurrent drain is a clean no-op (advisory lock)', async () => {
        const cfg = getTestPostgresConfig();
        const holder = new Client(cfg);
        const drainer = new Client(cfg);
        const K = 987654322;
        const where = `asset_contract = '${CONTRACT}' AND asset_id = $1`;
        try {
            await holder.connect();
            await drainer.connect();
            await drainer.query(`DELETE FROM atomicmarket_sales_filters_updates WHERE ${where}`, [K]);
            await drainer.query(ENQUEUE_ASSET, [K]); // seed a queued row

            // An "in-flight drain" holds the advisory lock.
            await holder.query('BEGIN');
            await holder.query("SELECT pg_advisory_xact_lock(hashtext('update_atomicmarket_sales_filters'))");

            // A real drain call while the lock is held must short-circuit to 0 and leave the
            // queue untouched (not claim/recompute/delete).
            const res = await drainer.query<{ removed: number }>(
                'SELECT update_atomicmarket_sales_filters(5000) AS removed',
            );
            expect(Number(res.rows[0].removed), 'locked-out drain returns 0').to.equal(0);
            const still = await drainer.query<{ c: number }>(
                `SELECT count(*)::int c FROM atomicmarket_sales_filters_updates WHERE ${where}`,
                [K],
            );
            expect(still.rows[0].c, 'queue row untouched by the no-op drain').to.equal(1);

            await holder.query('ROLLBACK'); // release the lock
        } finally {
            await drainer
                .query(`DELETE FROM atomicmarket_sales_filters_updates WHERE ${where}`, [K])
                .catch(() => undefined);
            await holder.end().catch(() => undefined);
            await drainer.end().catch(() => undefined);
        }
    });
});

// 1.7.13: real-time trigger events (prio 0) must never wait behind the bulk price
// refresh (prio 1) — the hourly refresh used to dump ~235k rows into the strict-FIFO
// queue ahead of fresh user actions (cancel/relist invisible for minutes to tens of
// minutes on WAX). The drain claims ORDER BY prio, seq; a real change upgrades a
// queued bulk row to the fast lane; the refresh never downgrades a pending real-time
// row; and the sliced refresh covers the variable-price listing set exactly once per
// cycle.
describe('update_atomicmarket_sales_filters — two-lane priority queue (1.7.13)', () => {
    txit('trigger enqueues land in the fast lane (prio 0)', async () => {
        await client.createFullSale();

        const lanes = await client.query<{ prio: number, c: number }>(
            'SELECT prio, count(*)::int c FROM atomicmarket_sales_filters_updates GROUP BY prio',
        );
        expect(lanes.rows.length, 'only one lane populated').to.equal(1);
        expect(Number(lanes.rows[0].prio), 'trigger events are real-time').to.equal(0);
        expect(lanes.rows[0].c).to.be.greaterThan(0);
    });

    txit('drain claims a younger real-time row before older bulk rows (asset lane)', async () => {
        for (const id of [801, 802, 803]) {
            await client.query(ENQUEUE_ASSET_BULK, [id]); // bulk first = lower seq
        }
        await client.query(ENQUEUE_ASSET, [804]); // real-time last = highest seq

        const removed = await client.query<{ removed: number }>(
            'SELECT update_atomicmarket_sales_filters(1) AS removed',
        );
        expect(Number(removed.rows[0].removed), 'one row claimed and removed').to.equal(1);

        const left = await client.query<{ asset_id: string, prio: number }>(
            `SELECT asset_id, prio FROM atomicmarket_sales_filters_updates
             WHERE asset_contract = '${CONTRACT}' ORDER BY asset_id`,
        );
        expect(left.rows.map(r => Number(r.asset_id)), 'real-time row drained, bulk rows remain')
            .to.deep.equal([801, 802, 803]);
        expect(left.rows.every(r => Number(r.prio) === 1)).to.be.true;
    });

    txit('drain claims a younger real-time row before older bulk rows (sale lane)', async () => {
        // Bulk-enqueue three synthetic variable-price listings via the real refresh fn.
        for (const id of [901, 902, 903]) {
            await client.query(SEED_VARIABLE_PRICE_LISTING, [id]);
        }
        await client.query('SELECT refresh_atomicmarket_sales_filters_price()');
        await client.query(ENQUEUE_SALE, [904]); // real-time, highest seq

        await client.query('SELECT update_atomicmarket_sales_filters(1)');

        const left = await client.query<{ sale_id: string }>(
            `SELECT sale_id FROM atomicmarket_sales_filters_updates
             WHERE market_contract = '${MARKET}' ORDER BY sale_id`,
        );
        expect(left.rows.map(r => Number(r.sale_id)), 'real-time sale drained first')
            .to.deep.equal([901, 902, 903]);
    });

    txit('a real change upgrades a queued bulk row to the fast lane (live trigger)', async () => {
        const { asset_id } = await client.createFullSale();
        await client.query('SELECT update_atomicmarket_sales_filters(5000)'); // empty the queue

        await client.query(ENQUEUE_ASSET_BULK, [asset_id]);
        const bulk = await client.query<{ seq: string, prio: number }>(
            `SELECT seq, prio FROM atomicmarket_sales_filters_updates
             WHERE asset_contract = '${CONTRACT}' AND asset_id = $1`, [asset_id],
        );
        expect(Number(bulk.rows[0].prio)).to.equal(1);

        // Real change: fires the actual update_atomicmarket_sales_filters_by_asset trigger.
        await client.query('UPDATE atomicassets_assets SET owner = \'newowner\' WHERE asset_id = $1', [asset_id]);

        const after = await client.query<{ seq: string, prio: number }>(
            `SELECT seq, prio FROM atomicmarket_sales_filters_updates
             WHERE asset_contract = '${CONTRACT}' AND asset_id = $1`, [asset_id],
        );
        expect(Number(after.rows[0].prio), 'upgraded to the fast lane').to.equal(0);
        expect(Number(after.rows[0].seq), 'version token bumped').to.be.greaterThan(Number(bulk.rows[0].seq));
    });

    txit('the bulk refresh never downgrades a pending real-time row', async () => {
        await client.query(SEED_VARIABLE_PRICE_LISTING, [905]);
        await client.query(ENQUEUE_SALE, [905]); // pending real-time row for the same key
        const before = await client.query<{ seq: string }>(
            `SELECT seq FROM atomicmarket_sales_filters_updates
             WHERE market_contract = '${MARKET}' AND sale_id = 905`,
        );

        await client.query('SELECT refresh_atomicmarket_sales_filters_price()');

        const after = await client.query<{ seq: string, prio: number }>(
            `SELECT seq, prio FROM atomicmarket_sales_filters_updates
             WHERE market_contract = '${MARKET}' AND sale_id = 905`,
        );
        expect(Number(after.rows[0].prio), 'stays in the fast lane (LEAST)').to.equal(0);
        expect(Number(after.rows[0].seq), 'version token still bumped').to.be.greaterThan(Number(before.rows[0].seq));
    });

    txit('sliced refresh covers the qualifying set exactly once per cycle, all prio 1', async () => {
        const TOTAL_SLICES = 3;
        const saleIds = [910, 911, 912, 913, 914, 915]; // spans every residue mod 3
        for (const id of saleIds) {
            await client.query(SEED_VARIABLE_PRICE_LISTING, [id]);
        }
        // Non-qualifying controls: fixed price (NULL variable_price) and non-listing state.
        await client.query(`
            INSERT INTO atomicmarket_sales_filters
                (sale_id, created_at_block, offer_id, updated_at_time, created_at_time,
                 sale_state, market_contract, assets_contract, maker_marketplace, variable_price)
            VALUES (916, 1, 916, 1, 1, 1, '${MARKET}', '${CONTRACT}', '', NULL),
                   (917, 1, 917, 1, 1, 3, '${MARKET}', '${CONTRACT}', '', TRUE)`);

        const seen: number[][] = [];
        for (let slice = 0; slice < TOTAL_SLICES; slice++) {
            await client.query('SELECT refresh_atomicmarket_sales_filters_price($1, $2)', [slice, TOTAL_SLICES]);
            const queued = await client.query<{ sale_id: string }>(
                `SELECT sale_id FROM atomicmarket_sales_filters_updates
                 WHERE market_contract = '${MARKET}' ORDER BY sale_id`,
            );
            seen.push(queued.rows.map(r => Number(r.sale_id)));
            expect(seen[slice], `slice ${slice} enqueues exactly its residue class`)
                .to.deep.equal(saleIds.filter(id => id % TOTAL_SLICES === slice));
            await client.query(`DELETE FROM atomicmarket_sales_filters_updates WHERE market_contract = '${MARKET}'`);
        }
        // Pairwise disjoint + union == full qualifying set.
        const union = seen.flat().sort((a, b) => a - b);
        expect(union, 'every qualifying listing covered exactly once per cycle').to.deep.equal(saleIds);

        await client.query('SELECT refresh_atomicmarket_sales_filters_price(0, 3)');
        const prios = await client.query<{ prio: number }>(
            `SELECT DISTINCT prio FROM atomicmarket_sales_filters_updates WHERE market_contract = '${MARKET}'`,
        );
        expect(prios.rows.map(r => Number(r.prio)), 'bulk refresh enqueues at prio 1').to.deep.equal([1]);
    });

    txit('zero-arg refresh call shape still enqueues the full qualifying set', async () => {
        for (const id of [920, 921, 922]) {
            await client.query(SEED_VARIABLE_PRICE_LISTING, [id]);
        }
        await client.query('SELECT refresh_atomicmarket_sales_filters_price()');
        const queued = await client.query<{ c: number }>(
            `SELECT count(*)::int c FROM atomicmarket_sales_filters_updates WHERE market_contract = '${MARKET}'`,
        );
        expect(queued.rows[0].c).to.equal(3);
    });

    txit('a misconfigured total_slices = 0 is a no-op, not a division-by-zero error', async () => {
        await client.query(SEED_VARIABLE_PRICE_LISTING, [925]);

        await client.query('SELECT refresh_atomicmarket_sales_filters_price(0, 0)'); // must not throw

        const queued = await client.query<{ c: number }>(
            `SELECT count(*)::int c FROM atomicmarket_sales_filters_updates WHERE market_contract = '${MARKET}'`,
        );
        expect(queued.rows[0].c, 'NULL predicate enqueues nothing').to.equal(0);
    });

    // Lane-upgrade variant of the 1.7.11 headline race: a bulk row claimed by an
    // in-flight drain gets upgraded to prio 0 mid-batch; the (key, seq) end-DELETE
    // guard must leave the upgraded row for the fast lane (prio change always comes
    // with a seq bump, so no extra guard column is needed).
    it('end-DELETE guard preserves a mid-batch lane upgrade', async () => {
        const cfg = getTestPostgresConfig();
        const drain = new Client(cfg);
        const reader = new Client(cfg);
        const K = 987654323;
        const where = `asset_contract = '${CONTRACT}' AND asset_id = $1`;
        try {
            await drain.connect();
            await reader.connect();
            await reader.query(`DELETE FROM atomicmarket_sales_filters_updates WHERE ${where}`, [K]);
            await reader.query(ENQUEUE_ASSET_BULK, [K]);

            await drain.query('BEGIN');
            const claimed = await drain.query<{ seq: string }>(
                `SELECT seq FROM atomicmarket_sales_filters_updates WHERE ${where} ORDER BY prio, seq LIMIT 1`,
                [K],
            );

            // Mid-batch real-time change upgrades the claimed bulk row.
            await reader.query(ENQUEUE_ASSET, [K]);

            const del = await drain.query(
                `DELETE FROM atomicmarket_sales_filters_updates WHERE ${where} AND seq = $2`,
                [K, claimed.rows[0].seq],
            );
            await drain.query('COMMIT');
            expect(del.rowCount, 'stale-seq end-DELETE must skip the upgraded row').to.equal(0);

            const survivor = await reader.query<{ prio: number }>(
                `SELECT prio FROM atomicmarket_sales_filters_updates WHERE ${where}`,
                [K],
            );
            expect(survivor.rows.length, 'upgraded row survives for reprocessing').to.equal(1);
            expect(Number(survivor.rows[0].prio), 'in the fast lane').to.equal(0);
        } finally {
            await reader
                .query(`DELETE FROM atomicmarket_sales_filters_updates WHERE ${where}`, [K])
                .catch(() => undefined);
            await drain.end().catch(() => undefined);
            await reader.end().catch(() => undefined);
        }
    });
});
