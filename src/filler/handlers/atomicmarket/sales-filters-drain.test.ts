import 'mocha';
import { expect } from 'chai';

import { drainAtomicmarketSalesFilters } from './index';

const STMT_TIMEOUT_MS = 300_000;
const WORK_MEM_MB = 2048;

/**
 * Minimal pool/client stub. connect() hands back a client that records every
 * SQL string it runs; each `SELECT update_atomicmarket_sales_filters` returns
 * the next `consumed` count from the sequence (0 once exhausted). Tracks
 * connect()/release() so we can assert the client is always returned.
 */
function makePool(consumedSequence: Array<number | string>): {
    pool: any;
    drainCalls: () => number;
    queries: string[];
    connects: () => number;
    releases: () => number;
} {
    let i = 0;
    let connects = 0;
    let releases = 0;
    const queries: string[] = [];
    const client = {
        query: async (sql: string, _params?: any[]) => {
            queries.push(sql);
            if (sql.startsWith('SELECT update_atomicmarket_sales_filters')) {
                const consumed = consumedSequence[i] ?? 0;
                i += 1;
                return { rows: [{ consumed }] };
            }
            return { rows: [] };
        },
        release: () => { releases += 1; },
    };
    const pool = {
        connect: async () => { connects += 1; return client; },
    };
    return { pool, drainCalls: () => i, queries, connects: () => connects, releases: () => releases };
}

describe('drainAtomicmarketSalesFilters', () => {
    it('loops until a call consumes 0 rows, summing total consumed', async () => {
        const { pool, drainCalls } = makePool([5000, 5000, 1200, 0]);
        const total = await drainAtomicmarketSalesFilters(pool, 5000, 30_000, STMT_TIMEOUT_MS, WORK_MEM_MB);

        expect(total).to.equal(11_200);
        // 3 non-empty batches + 1 terminating empty batch
        expect(drainCalls()).to.equal(4);
    });

    it('yields between batches when shouldYield() turns true, even with budget + rows remaining', async () => {
        // Reader-priority: a live batch is ~36s, so the gate must be re-checked
        // BETWEEN batches (not only at tick start). Queue never drains and the
        // budget is huge; shouldYield flips true after the 2nd batch -> the loop
        // must stop at 2 batches, not run out the budget.
        const { pool, drainCalls } = makePool([5000, 5000, 5000, 5000, 5000]);
        let calls = 0;
        const shouldYield = (): boolean => {
            calls += 1;
            return calls >= 2; // false after batch 1, true after batch 2
        };
        const total = await drainAtomicmarketSalesFilters(
            pool, 5000, 10 * 60_000, STMT_TIMEOUT_MS, WORK_MEM_MB, shouldYield,
        );

        expect(total).to.equal(10_000); // exactly 2 batches before yielding
        expect(drainCalls()).to.equal(2);
    });

    it('makes exactly one call when the queue is already empty', async () => {
        const { pool, drainCalls } = makePool([0]);
        const total = await drainAtomicmarketSalesFilters(pool, 5000, 30_000, STMT_TIMEOUT_MS, WORK_MEM_MB);

        expect(total).to.equal(0);
        expect(drainCalls()).to.equal(1);
    });

    it('stops at the time budget even if rows remain', async () => {
        // Always reports a full batch consumed (queue never drains). A clock that
        // jumps past the deadline after the first batch must stop the loop.
        const client = { query: async (sql: string) =>
            (sql.startsWith('SELECT update_atomicmarket_sales_filters')
                ? { rows: [{ consumed: 5000 }] } : { rows: [] }), release: () => undefined };
        const pool = { connect: async () => client };
        let t = 0;
        const now = (): number => {
            const v = t;
            t += 20_000; // each read advances 20s
            return v;
        };
        // deadline = now() (=0) + 25_000. loop-check reads 20_000 (<25_000 -> continue),
        // next read 40_000 (stop). Exactly 2 batches before the budget tripped.
        const total = await drainAtomicmarketSalesFilters(pool, 5000, 25_000, STMT_TIMEOUT_MS, WORK_MEM_MB, () => false, now);

        expect(total).to.equal(10_000);
    });

    it('coerces string consumed counts (pg may return bigint/numeric as string)', async () => {
        const { pool } = makePool(['5000', '0']);
        const total = await drainAtomicmarketSalesFilters(pool, 5000, 30_000, STMT_TIMEOUT_MS, WORK_MEM_MB);
        expect(total).to.equal(5000);
    });

    it('wraps each batch in a txn and raises statement_timeout via SET LOCAL BEFORE the drain query', async () => {
        // This is the fix for the 2026-05-29 freeze: a connection-/role-level
        // statement_timeout does not survive PgBouncer transaction pooling, so the
        // timeout MUST be SET LOCAL inside each batch's transaction, before the
        // drain query (statement_timeout is armed when the statement begins).
        const { pool, queries } = makePool([0]);
        await drainAtomicmarketSalesFilters(pool, 500, 30_000, STMT_TIMEOUT_MS, WORK_MEM_MB);

        expect(queries).to.deep.equal([
            'BEGIN',
            `SET LOCAL statement_timeout = ${STMT_TIMEOUT_MS}`,
            "SET LOCAL work_mem = '2048MB'",
            'SELECT update_atomicmarket_sales_filters($1) AS consumed',
            'COMMIT',
        ]);
        const setLocalIdx = queries.indexOf(`SET LOCAL statement_timeout = ${STMT_TIMEOUT_MS}`);
        const drainIdx = queries.findIndex(q => q.startsWith('SELECT update_atomicmarket_sales_filters'));
        expect(setLocalIdx).to.be.greaterThan(-1);
        expect(setLocalIdx).to.be.lessThan(drainIdx); // SET LOCAL precedes the drain query
    });

    it('threads a non-default work_mem through to the SET LOCAL (env-override path)', async () => {
        // The operator retuning lever (ATOMICMARKET_SALES_FILTERS_WORK_MEM_MB) is
        // passed as the workMemMb argument; assert a non-default value actually
        // reaches the emitted SQL rather than being pinned at the 2048MB default.
        const { pool, queries } = makePool([0]);
        await drainAtomicmarketSalesFilters(pool, 500, 30_000, STMT_TIMEOUT_MS, 512);

        expect(queries).to.include("SET LOCAL work_mem = '512MB'");
        expect(queries).to.not.include("SET LOCAL work_mem = '2048MB'");
    });

    it('rolls back and rethrows when the drain query errors, and always releases the client', async () => {
        let released = false;
        const queries: string[] = [];
        const client = {
            query: async (sql: string) => {
                queries.push(sql);
                if (sql.startsWith('SELECT update_atomicmarket_sales_filters')) {
                    throw new Error('canceling statement due to statement timeout'); // 57014
                }
                return { rows: [] };
            },
            release: () => { released = true; },
        };
        const pool = { connect: async () => client };

        await expect(
            drainAtomicmarketSalesFilters(pool, 500, 30_000, STMT_TIMEOUT_MS, WORK_MEM_MB),
        ).to.be.rejectedWith(/statement timeout/);

        expect(queries).to.include('ROLLBACK');
        expect(queries).to.not.include('COMMIT');
        expect(released).to.equal(true); // client returned to the pool even on error
    });
});
