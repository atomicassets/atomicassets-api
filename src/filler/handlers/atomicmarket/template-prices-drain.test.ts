import 'mocha';
import { expect } from 'chai';

import { drainAtomicmarketTemplatePrices, TEMPLATE_PRICES_WORK_PROBE_SQL } from './index';

const STMT_TIMEOUT_S = 900;
const WORK_MEM_MB = 1024;
const DRAIN_SQL = 'SELECT update_atomicmarket_template_prices($1) AS released';

/**
 * Minimal pool/client stub mirroring the sales-filter drain's. connect() hands
 * back a client that records every SQL string (and its bind values) it runs;
 * each `SELECT update_atomicmarket_template_prices` returns the next `released`
 * count from the sequence (0 once exhausted). Tracks connect()/release() so we
 * can assert the client is always returned.
 */
function makePool(releasedSequence: Array<number | string>): {
    pool: any;
    drainCalls: () => number;
    queries: string[];
    params: any[][];
    releases: () => number;
} {
    let i = 0;
    let releases = 0;
    const queries: string[] = [];
    const params: any[][] = [];
    const client = {
        query: async (sql: string, values?: any[]) => {
            queries.push(sql);
            if (values) {
                params.push(values);
            }
            if (sql.startsWith('SELECT update_atomicmarket_template_prices')) {
                const released = releasedSequence[i] ?? 0;
                i += 1;
                return { rows: [{ released }] };
            }
            return { rows: [] };
        },
        release: () => { releases += 1; },
    };
    const pool = {
        connect: async () => client,
    };
    return { pool, drainCalls: () => i, queries, params, releases: () => releases };
}

describe('drainAtomicmarketTemplatePrices', () => {
    it('loops until a batch releases 0 queue rows, summing the total released', async () => {
        const { pool, drainCalls } = makePool([200, 200, 45, 0]);
        const total = await drainAtomicmarketTemplatePrices(pool, 200, 55_000, STMT_TIMEOUT_S, WORK_MEM_MB);

        expect(total).to.equal(445);
        // 3 non-empty batches + 1 terminating empty batch
        expect(drainCalls()).to.equal(4);
    });

    it('yields between batches when shouldYield() turns true, even with budget + backlog remaining', async () => {
        // What bounding the work buys: a single-statement recompute cannot be
        // interrupted, so a reader falling behind mid-run waits out the whole run. The
        // gate is therefore re-checked BETWEEN batches, not only at tick start
        // (runGatedDrain). Queue never drains and the budget is huge; shouldYield
        // flips true after the 2nd batch -> the loop must stop at 2 batches.
        const { pool, drainCalls } = makePool([200, 200, 200, 200, 200]);
        let calls = 0;
        const shouldYield = (): boolean => {
            calls += 1;
            return calls >= 2;
        };
        const total = await drainAtomicmarketTemplatePrices(
            pool, 200, 10 * 60_000, STMT_TIMEOUT_S, WORK_MEM_MB, shouldYield,
        );

        expect(total).to.equal(400); // exactly 2 batches before yielding
        expect(drainCalls()).to.equal(2);
    });

    it('makes exactly one call when the due queue is already empty', async () => {
        const { pool, drainCalls } = makePool([0]);
        const total = await drainAtomicmarketTemplatePrices(pool, 200, 55_000, STMT_TIMEOUT_S, WORK_MEM_MB);

        expect(total).to.equal(0);
        expect(drainCalls()).to.equal(1);
    });

    it('stops at the time budget even if the backlog remains', async () => {
        // Always reports a full batch released (queue never drains). A clock that
        // jumps past the deadline after the second batch must stop the loop.
        const { pool, drainCalls } = makePool([200, 200, 200, 200, 200]);
        let t = 0;
        const now = (): number => {
            const v = t;
            t += 20_000; // each read advances 20s
            return v;
        };
        // deadline = now() (=0) + 25_000. loop-check reads 20_000 (<25_000 -> continue),
        // next read 40_000 (stop). Exactly 2 batches before the budget tripped.
        const total = await drainAtomicmarketTemplatePrices(
            pool, 200, 25_000, STMT_TIMEOUT_S, WORK_MEM_MB, () => false, now,
        );

        expect(total).to.equal(400);
        expect(drainCalls()).to.equal(2);
    });

    it('coerces string released counts (pg returns the INT return value as a string in some drivers)', async () => {
        const { pool } = makePool(['200', '0']);
        const total = await drainAtomicmarketTemplatePrices(pool, 200, 55_000, STMT_TIMEOUT_S, WORK_MEM_MB);
        expect(total).to.equal(200);
    });

    it('wraps each batch in its own txn with SET LOCAL work_mem / statement_timeout / async commit BEFORE the drain query', async () => {
        // Same PgBouncer-safe, txn-scoped rationale as the sales-filter drain: a
        // connection-level statement_timeout does not survive transaction pooling, and
        // statement_timeout is armed when the statement begins, so it must be SET LOCAL
        // before the call. Per-batch (not per-run) is what releases the max-1
        // longRunningPool client between batches.
        const { pool, queries } = makePool([0]);
        await drainAtomicmarketTemplatePrices(pool, 200, 55_000, STMT_TIMEOUT_S, WORK_MEM_MB);

        expect(queries).to.deep.equal([
            'BEGIN',
            "SET LOCAL work_mem = '1024MB'",
            "SET LOCAL statement_timeout = '900s'",
            'SET LOCAL synchronous_commit = off',
            DRAIN_SQL,
            'COMMIT',
        ]);
    });

    it('binds the batch size as a parameter rather than interpolating it into the SQL', async () => {
        const { pool, queries, params } = makePool([0]);
        await drainAtomicmarketTemplatePrices(pool, 37, 55_000, STMT_TIMEOUT_S, WORK_MEM_MB);

        expect(queries).to.include(DRAIN_SQL);
        expect(params).to.deep.equal([[37]]);
        expect(queries.some(q => q.includes('37'))).to.equal(false);
    });

    it('threads non-default work_mem and statement_timeout through to the SET LOCALs (env-override path)', async () => {
        const { pool, queries } = makePool([0]);
        await drainAtomicmarketTemplatePrices(pool, 200, 55_000, 60, 512);

        expect(queries).to.include("SET LOCAL work_mem = '512MB'");
        expect(queries).to.include("SET LOCAL statement_timeout = '60s'");
        expect(queries).to.not.include("SET LOCAL work_mem = '1024MB'");
        expect(queries).to.not.include("SET LOCAL statement_timeout = '900s'");
    });

    it('rolls back and rethrows when a batch errors, and always releases the client', async () => {
        let released = false;
        const queries: string[] = [];
        const client = {
            query: async (sql: string) => {
                queries.push(sql);
                if (sql.startsWith('SELECT update_atomicmarket_template_prices')) {
                    throw new Error('canceling statement due to statement timeout'); // 57014
                }
                return { rows: [] };
            },
            release: () => { released = true; },
        };
        const pool = { connect: async () => client };

        await expect(
            drainAtomicmarketTemplatePrices(pool, 200, 55_000, STMT_TIMEOUT_S, WORK_MEM_MB),
        ).to.be.rejectedWith(/statement timeout/);

        expect(queries).to.include('ROLLBACK');
        expect(queries).to.not.include('COMMIT');
        expect(released).to.equal(true); // client returned to the pool even on error
    });

    it('returns the client to the pool after every batch, not just the last one', async () => {
        const { pool, releases } = makePool([200, 200, 0]);
        await drainAtomicmarketTemplatePrices(pool, 200, 55_000, STMT_TIMEOUT_S, WORK_MEM_MB);

        expect(releases()).to.equal(3); // one connect/release pair per batch
    });
});

describe('TEMPLATE_PRICES_WORK_PROBE_SQL', () => {
    it('measures due-ness against the reader block time, never wall clock', () => {
        // On a lagging filler the reader's block time and wall clock diverge by the
        // lag. The claim inside update_atomicmarket_template_prices() gates aging rows
        // on MAX(block_time); a wall-clock probe would report work the claim will not
        // take and wake an empty drain every tick.
        expect(TEMPLATE_PRICES_WORK_PROBE_SQL).to.match(/refresh_at\s*<=\s*\(SELECT MAX\(block_time\) FROM contract_readers\)/);
        expect(TEMPLATE_PRICES_WORK_PROBE_SQL).to.not.match(/now\(\)|CURRENT_TIMESTAMP|clock_timestamp|extract\s*\(\s*epoch/i);
    });

    it('is a cheap bounded EXISTS probe on the queue, not a count', () => {
        expect(TEMPLATE_PRICES_WORK_PROBE_SQL).to.match(/SELECT EXISTS\(/);
        expect(TEMPLATE_PRICES_WORK_PROBE_SQL).to.include('FROM atomicmarket_template_prices_updates');
        expect(TEMPLATE_PRICES_WORK_PROBE_SQL).to.include('LIMIT 1');
        expect(TEMPLATE_PRICES_WORK_PROBE_SQL).to.include('AS has_work');
        expect(TEMPLATE_PRICES_WORK_PROBE_SQL).to.not.match(/count\(/i);
    });
});
