import 'mocha';
import { expect } from 'chai';

import { drainAtomicmarketMints } from './index';

const FN = 'update_atomicmarket_sale_mints';
const CONTRACT = 'atomicmarket';
const LIB = 123456;
const BATCH = 2000;

/**
 * Minimal pool stub: each `SELECT <fn>(...)` returns the next `updated` count
 * from the sequence (0 once exhausted) and records the SQL + params it ran.
 */
function makePool(updatedSequence: Array<number | string>): {
    pool: any;
    calls: () => number;
    queries: Array<{ sql: string; params?: any[] }>;
} {
    let i = 0;
    const queries: Array<{ sql: string; params?: any[] }> = [];
    const pool = {
        query: async (sql: string, params?: any[]) => {
            queries.push({ sql, params });
            const updated = updatedSequence[i] ?? 0;
            i += 1;
            return { rows: [{ updated }] };
        },
    };
    return { pool, calls: () => i, queries };
}

describe('drainAtomicmarketMints', () => {
    it('loops until a batch resolves 0 rows, summing total updated', async () => {
        const { pool, calls } = makePool([2000, 2000, 350, 0]);
        const total = await drainAtomicmarketMints(pool, FN, CONTRACT, LIB, BATCH, 30_000, () => 0);

        expect(total).to.equal(4350);
        // 3 non-empty batches + 1 terminating empty batch
        expect(calls()).to.equal(4);
    });

    it('makes exactly one call when nothing is resolvable (first batch 0)', async () => {
        const { pool, calls } = makePool([0]);
        const total = await drainAtomicmarketMints(pool, FN, CONTRACT, LIB, BATCH, 30_000, () => 0);

        expect(total).to.equal(0);
        expect(calls()).to.equal(1);
    });

    it('stops at the time budget even if batches keep resolving full counts', async () => {
        const pool = { query: async () => ({ rows: [{ updated: 2000 }] }) };
        let t = 0;
        const now = (): number => {
            const v = t;
            t += 20_000; // each read advances 20s
            return v;
        };
        // deadline = now()(=0) + 25_000. loop-check reads 20_000 (<25_000 -> continue),
        // next read 40_000 (stop). Exactly 2 batches before the budget tripped.
        const total = await drainAtomicmarketMints(pool, FN, CONTRACT, LIB, BATCH, 25_000, now);

        expect(total).to.equal(4000);
    });

    it('coerces string counts (pg may return bigint/numeric as string)', async () => {
        const { pool } = makePool(['2000', '0']);
        const total = await drainAtomicmarketMints(pool, FN, CONTRACT, LIB, BATCH, 30_000, () => 0);
        expect(total).to.equal(2000);
    });

    it('calls the named function with (contract, lib, batchSize) bound params', async () => {
        const { pool, queries } = makePool([0]);
        await drainAtomicmarketMints(pool, FN, CONTRACT, LIB, BATCH, 30_000, () => 0);

        expect(queries[0].sql).to.equal(`SELECT ${FN}($1, $2, $3) AS updated`);
        expect(queries[0].params).to.deep.equal([CONTRACT, LIB, BATCH]);
    });

    it('rethrows when a batch query errors', async () => {
        const pool = {
            query: async () => { throw new Error('canceling statement due to statement timeout'); },
        };
        await expect(
            drainAtomicmarketMints(pool, FN, CONTRACT, LIB, BATCH, 30_000, () => 0),
        ).to.be.rejectedWith(/statement timeout/);
    });

    it('refuses an fnName outside the allowlist (no query issued)', async () => {
        let called = false;
        const pool = { query: async () => { called = true; return { rows: [{ updated: 0 }] }; } };
        await expect(
            drainAtomicmarketMints(pool, 'evil(); DROP TABLE atomicmarket_sales; --', CONTRACT, LIB, BATCH, 30_000, () => 0),
        ).to.be.rejectedWith(/unknown function/);
        expect(called).to.equal(false);
    });
});
