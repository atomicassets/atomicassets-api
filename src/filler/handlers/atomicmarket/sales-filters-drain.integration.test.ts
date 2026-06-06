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
        DO UPDATE SET seq = nextval('atomicmarket_sales_filters_updates_seq')`;

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
