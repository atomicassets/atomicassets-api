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

const { client, txit } = initAtomicMarketTest();

const ENQUEUE_ASSET = `
    INSERT INTO atomicmarket_sales_filters_updates(asset_contract, asset_id)
    VALUES ('aatest', $1)
    ON CONFLICT (asset_contract, asset_id) WHERE asset_id IS NOT NULL
        DO UPDATE SET seq = nextval('atomicmarket_sales_filters_updates_seq')`;

describe('update_atomicmarket_sales_filters — queue-claim decoupling (1.7.11)', () => {
    txit('drains a queued sale: queue emptied, filter row recomputed', async () => {
        const { sale_id } = await client.createFullSale();

        const before = await client.query<{ c: number }>(
            'SELECT count(*)::int c FROM atomicmarket_sales_filters_updates',
        );
        expect(before.rows[0].c, 'createFullSale should enqueue work').to.be.greaterThan(0);

        await client.query('SELECT update_atomicmarket_sales_filters(5000)');

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
        await client.query(ENQUEUE_ASSET, [424242]);
        const s0 = (
            await client.query<{ seq: string }>(
                'SELECT seq FROM atomicmarket_sales_filters_updates WHERE asset_id = $1',
                [424242],
            )
        ).rows[0].seq;
        await client.query(ENQUEUE_ASSET, [424242]);
        const s1 = (
            await client.query<{ seq: string }>(
                'SELECT seq FROM atomicmarket_sales_filters_updates WHERE asset_id = $1',
                [424242],
            )
        ).rows[0].seq;
        expect(Number(s1)).to.be.greaterThan(Number(s0));
    });

    // Headline correctness test: needs two real connections (txit's single-txn
    // model cannot represent concurrent backends). Models the drain's three phases
    // (CLAIM select → [recompute window] → version-guarded end-DELETE) on one
    // connection while a reader enqueues on the other in the middle.
    it('reader enqueue is not blocked by an in-flight drain, and a racing change is not lost', async () => {
        const cfg = getTestPostgresConfig();
        const drain = new Client(cfg);
        const reader = new Client(cfg);
        const K = 987654321; // dedicated asset key, cleaned up in finally
        try {
            await drain.connect();
            await reader.connect();
            await reader.query('DELETE FROM atomicmarket_sales_filters_updates WHERE asset_id = $1', [K]);

            // Seed a queued change for key K.
            await reader.query(ENQUEUE_ASSET, [K]);

            // DRAIN phase 1 — CLAIM: SELECT (no lock), capture seq, hold the txn open
            // (this stands in for the ~25s recompute, during which the real function
            // also holds no queue lock).
            await drain.query('BEGIN');
            const claimed = await drain.query<{ seq: string }>(
                'SELECT seq FROM atomicmarket_sales_filters_updates WHERE asset_id = $1 ORDER BY seq LIMIT 5000',
                [K],
            );
            const s0 = claimed.rows[0].seq;

            // READER — enqueue the SAME key while the drain txn is open. Under the old
            // DELETE-at-start design this ON CONFLICT would speculative-wait on the
            // drain txn (~25s). It must now return effectively immediately.
            const t0 = Date.now();
            await reader.query(ENQUEUE_ASSET, [K]);
            const elapsedMs = Date.now() - t0;
            expect(elapsedMs, 'reader enqueue must not block on the drain txn').to.be.lessThan(1000);

            // DRAIN phase 3 — version-guarded end-DELETE keyed on the captured seq.
            const del = await drain.query(
                'DELETE FROM atomicmarket_sales_filters_updates WHERE asset_id = $1 AND seq = $2',
                [K, s0],
            );
            await drain.query('COMMIT');
            expect(del.rowCount, 'stale-seq end-DELETE must skip the re-enqueued row').to.equal(0);

            // The racing change survives (bumped seq) → it will be reprocessed → not lost.
            const survive = await reader.query<{ c: number }>(
                'SELECT count(*)::int c FROM atomicmarket_sales_filters_updates WHERE asset_id = $1',
                [K],
            );
            expect(survive.rows[0].c, 'racing change must survive (no lost update)').to.equal(1);
        } finally {
            await reader.query('DELETE FROM atomicmarket_sales_filters_updates WHERE asset_id = $1', [K]).catch(() => undefined);
            await drain.end().catch(() => undefined);
            await reader.end().catch(() => undefined);
        }
    });
});
