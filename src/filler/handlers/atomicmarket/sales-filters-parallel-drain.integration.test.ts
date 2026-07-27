import 'mocha';
import { expect } from 'chai';
import { Client } from 'pg';

import { initAtomicMarketTest } from '../../../api/namespaces/atomicmarket/test';
import { getTestPostgresConfig } from '../../../utils/test';

// Integration coverage for the 1.7.25 partition-parallel drain (backport of the v2 line's 2.0.1)
// (update_atomicmarket_sales_filters_partition + normalize_atomicmarket_sales_filters_offers).
//
// Headline guarantees under test:
//   * PARITY  - the partition recompute produces a byte-identical
//     atomicmarket_sales_filters row to the stock drain (the recompute CTE is
//     verbatim 1.7.11; this proves the wiring around it preserves that).
//   * SCOPE   - a worker only consumes sale rows of its own hash partition;
//     asset/offer rows are never claimed by workers.
//   * LOCKS   - workers take the stock drain's advisory key SHARED: the stock
//     drain no-ops while a worker is in flight and vice versa; a duplicate
//     worker on the same partition no-ops (per-partition exclusive).
//
// Lock tests need two real connections (txit's single-txn model cannot represent
// concurrent backends) and use fake queued sale keys: a queued sale with no
// backing atomicmarket_sales row is consumed (removed, returns 1) by an
// unobstructed drain, so "returns 0 AND the row survives" isolates the lockout
// from the empty-queue 0.

const GLOBAL_KEY = "hashtext('update_atomicmarket_sales_filters')";
const PARTITION_KEY = "hashtext('update_atomicmarket_sales_filters_partition')";

const { client, txit } = initAtomicMarketTest();

async function queueCounts(): Promise<{ assets: number; sales: number; offers: number }> {
    const r = await client.query<{ assets: number; sales: number; offers: number }>(
        `SELECT
            COUNT(*) FILTER (WHERE asset_id IS NOT NULL)::int assets,
            COUNT(*) FILTER (WHERE sale_id IS NOT NULL)::int sales,
            COUNT(*) FILTER (WHERE offer_id IS NOT NULL)::int offers
        FROM atomicmarket_sales_filters_updates`,
    );
    return r.rows[0];
}

describe('update_atomicmarket_sales_filters_partition - partition-parallel drain (1.7.25)', () => {
    txit('single-partition drain consumes sale rows, recomputes the filter row, leaves asset/offer rows alone', async () => {
        const { sale_id } = await client.createFullSale();

        const before = await queueCounts();
        expect(before.sales, 'createFullSale should enqueue a sale row').to.be.greaterThan(0);

        // part_count=1 => every sale_id is in partition 0.
        const removed = await client.query<{ removed: number }>(
            'SELECT update_atomicmarket_sales_filters_partition(1, 0, 5000) AS removed',
        );
        expect(Number(removed.rows[0].removed), 'consumes exactly the queued sale rows').to.equal(before.sales);

        const after = await queueCounts();
        expect(after.sales, 'sale rows drained').to.equal(0);
        expect(after.assets, 'asset rows are NOT claimed by workers').to.equal(before.assets);
        expect(after.offers, 'offer rows are NOT claimed by workers').to.equal(before.offers);

        const filtered = await client.query<{ c: number }>(
            'SELECT count(*)::int c FROM atomicmarket_sales_filters WHERE sale_id = $1',
            [sale_id],
        );
        expect(filtered.rows[0].c, 'filter row recomputed').to.be.greaterThan(0);
    });

    txit('a worker only consumes its own hash partition', async () => {
        const a = await client.createFullSale();
        const b = await client.createFullSale({ sale_id: Number(a.sale_id) + 1 }); // adjacent => opposite parity

        const mine = Number(a.sale_id) % 2;
        await client.query('SELECT update_atomicmarket_sales_filters_partition(2, $1, 5000)', [mine]);

        const left = await client.query<{ sale_id: string }>(
            'SELECT sale_id FROM atomicmarket_sales_filters_updates WHERE sale_id IS NOT NULL',
        );
        const leftIds = left.rows.map(r => Number(r.sale_id));
        expect(leftIds, "the other partition's sale row survives").to.include(Number(b.sale_id));
        expect(leftIds, 'own partition fully consumed').to.not.include(Number(a.sale_id));
    });

    txit('PARITY: partition recompute recreates a byte-identical filter row vs the stock drain', async () => {
        const { sale_id } = await client.createFullSale();

        // Stock drain produces the reference row.
        await client.query('SELECT update_atomicmarket_sales_filters(5000)');
        const reference = await client.query<{ row: unknown; market_contract: string }>(
            'SELECT to_jsonb(m) AS row, market_contract FROM atomicmarket_sales_filters m WHERE sale_id = $1',
            [sale_id],
        );
        expect(reference.rows.length, 'stock drain created the reference row').to.equal(1);

        // Wipe it and have a partition worker rebuild it from scratch.
        await client.query('DELETE FROM atomicmarket_sales_filters WHERE sale_id = $1', [sale_id]);
        await client.query(
            `INSERT INTO atomicmarket_sales_filters_updates (market_contract, sale_id) VALUES ($1, $2)
            ON CONFLICT (market_contract, sale_id) WHERE sale_id IS NOT NULL
                DO UPDATE SET seq = nextval('atomicmarket_sales_filters_updates_seq')`,
            [reference.rows[0].market_contract, sale_id],
        );
        await client.query('SELECT update_atomicmarket_sales_filters_partition(1, 0, 5000)');

        const rebuilt = await client.query<{ row: unknown }>(
            'SELECT to_jsonb(m) AS row FROM atomicmarket_sales_filters m WHERE sale_id = $1',
            [sale_id],
        );
        expect(rebuilt.rows.length, 'partition drain recreated the row').to.equal(1);
        expect(rebuilt.rows[0].row, 'identical filter row content').to.deep.equal(reference.rows[0].row);
    });

    txit('normalize converts queued offer rows into queued sale rows, then a worker consumes them', async () => {
        const { sale_id } = await client.createFullSale();
        // Settle the queue, then queue ONLY the offer-change for this sale.
        await client.query('SELECT update_atomicmarket_sales_filters(5000)');
        const ref = await client.query<{ assets_contract: string; offer_id: string; market_contract: string }>(
            'SELECT assets_contract, offer_id, market_contract FROM atomicmarket_sales_filters WHERE sale_id = $1',
            [sale_id],
        );
        await client.query(
            `INSERT INTO atomicmarket_sales_filters_updates (asset_contract, offer_id) VALUES ($1, $2)
            ON CONFLICT (asset_contract, offer_id) WHERE offer_id IS NOT NULL
                DO UPDATE SET seq = nextval('atomicmarket_sales_filters_updates_seq')`,
            [ref.rows[0].assets_contract, ref.rows[0].offer_id],
        );

        const normalized = await client.query<{ removed: number }>(
            'SELECT normalize_atomicmarket_sales_filters_offers(5000) AS removed',
        );
        expect(Number(normalized.rows[0].removed), 'offer row consumed by normalize').to.equal(1);

        const after = await queueCounts();
        expect(after.offers, 'no offer rows left').to.equal(0);
        const queuedSale = await client.query<{ c: number }>(
            'SELECT count(*)::int c FROM atomicmarket_sales_filters_updates WHERE market_contract = $1 AND sale_id = $2',
            [ref.rows[0].market_contract, sale_id],
        );
        expect(queuedSale.rows[0].c, "the offer's sale is now queued").to.equal(1);

        const removed = await client.query<{ removed: number }>(
            'SELECT update_atomicmarket_sales_filters_partition(1, 0, 5000) AS removed',
        );
        expect(Number(removed.rows[0].removed), 'worker consumes the normalized sale row').to.be.greaterThan(0);
    });

    txit('rejects invalid partition arguments', async () => {
        let threw = false;
        try {
            await client.query('SELECT update_atomicmarket_sales_filters_partition(4, 4, 5000)');
        } catch {
            threw = true;
        }
        expect(threw, 'part_index >= part_count must raise').to.equal(true);
    });

    // --- two-connection lock-protocol tests (real backends, fake queued sale keys) ---

    function lockTest(
        title: string,
        holderLockSql: string,
        drainSql: string,
        fakeKey: number,
    ): void {
        it(title, async () => {
            const cfg = getTestPostgresConfig();
            const holder = new Client(cfg);
            const drainer = new Client(cfg);
            const where = "market_contract = 'locktest' AND sale_id = $1";
            try {
                await holder.connect();
                await drainer.connect();
                await drainer.query(`DELETE FROM atomicmarket_sales_filters_updates WHERE ${where}`, [fakeKey]);
                await drainer.query(
                    'INSERT INTO atomicmarket_sales_filters_updates (market_contract, sale_id) VALUES (\'locktest\', $1)',
                    [fakeKey],
                );

                await holder.query('BEGIN');
                await holder.query(holderLockSql);

                const blocked = await drainer.query<{ removed: number }>(drainSql);
                expect(Number(blocked.rows[0].removed), 'locked-out drain returns 0').to.equal(0);
                const survives = await drainer.query<{ c: number }>(
                    `SELECT count(*)::int c FROM atomicmarket_sales_filters_updates WHERE ${where}`,
                    [fakeKey],
                );
                expect(survives.rows[0].c, 'queue row untouched while locked out').to.equal(1);

                await holder.query('ROLLBACK'); // release

                const free = await drainer.query<{ removed: number }>(drainSql);
                expect(Number(free.rows[0].removed), 'same call consumes the row once unblocked').to.be.greaterThan(0);
            } finally {
                await drainer
                    .query(`DELETE FROM atomicmarket_sales_filters_updates WHERE ${where}`, [fakeKey])
                    .catch(() => undefined);
                await holder.end().catch(() => undefined);
                await drainer.end().catch(() => undefined);
            }
        });
    }

    // Worker in flight (shared global) => the stock drain must no-op.
    lockTest(
        'stock drain no-ops while a partition worker is in flight (shared global key)',
        `SELECT pg_advisory_xact_lock_shared(${GLOBAL_KEY})`,
        'SELECT update_atomicmarket_sales_filters(5000) AS removed',
        987654421,
    );

    // Stock drain in flight (exclusive global) => workers must no-op.
    lockTest(
        'a partition worker no-ops while the stock drain is in flight (exclusive global key)',
        `SELECT pg_advisory_xact_lock(${GLOBAL_KEY})`,
        `SELECT update_atomicmarket_sales_filters_partition(4, ${987654422 % 4}, 5000) AS removed`,
        987654422,
    );

    // Same partition doubly launched => second worker must no-op.
    lockTest(
        'a duplicate worker on the same partition no-ops (per-partition exclusive)',
        `SELECT pg_advisory_xact_lock(${PARTITION_KEY}, ${987654423 % 4})`,
        `SELECT update_atomicmarket_sales_filters_partition(4, ${987654423 % 4}, 5000) AS removed`,
        987654423,
    );

    it('workers on DIFFERENT partitions are not mutually exclusive', async () => {
        const cfg = getTestPostgresConfig();
        const a = new Client(cfg);
        const b = new Client(cfg);
        const keyA = 987654424; // % 4 = 0
        const keyB = 987654425; // % 4 = 1
        const where = "market_contract = 'locktest' AND sale_id = $1";
        try {
            await a.connect();
            await b.connect();
            for (const k of [keyA, keyB]) {
                await a.query(`DELETE FROM atomicmarket_sales_filters_updates WHERE ${where}`, [k]);
                await a.query(
                    'INSERT INTO atomicmarket_sales_filters_updates (market_contract, sale_id) VALUES (\'locktest\', $1)',
                    [k],
                );
            }

            // Worker A holds its locks (open txn) while worker B runs on another partition.
            await a.query('BEGIN');
            const ra = await a.query<{ removed: number }>(
                'SELECT update_atomicmarket_sales_filters_partition(4, $1, 5000) AS removed',
                [keyA % 4],
            );
            expect(Number(ra.rows[0].removed), 'worker A consumed its row').to.equal(1);

            const rb = await b.query<{ removed: number }>(
                'SELECT update_atomicmarket_sales_filters_partition(4, $1, 5000) AS removed',
                [keyB % 4],
            );
            expect(Number(rb.rows[0].removed), "worker B runs concurrently (A's locks still held)").to.equal(1);

            await a.query('COMMIT');
        } finally {
            for (const k of [keyA, keyB]) {
                await b
                    .query(`DELETE FROM atomicmarket_sales_filters_updates WHERE ${where}`, [k])
                    .catch(() => undefined);
            }
            await a.end().catch(() => undefined);
            await b.end().catch(() => undefined);
        }
    });
});
