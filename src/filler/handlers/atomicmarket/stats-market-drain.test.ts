import 'mocha';
import { expect } from 'chai';

import { drainAtomicmarketStatsMarket, STATS_MARKET_WORK_PROBE_SQL } from './index';

const STMT_TIMEOUT_S = 300;
const WORK_MEM_MB = 256;
const BATCH = 1000;
const DRAIN_SQL = 'SELECT update_atomicmarket_stats_market($1) AS released';

/**
 * Minimal pool/client stub mirroring the template-prices drain's. connect() hands
 * back a client that records every SQL string (and its bind values) it runs; each
 * `SELECT update_atomicmarket_stats_market` returns the next `released` count from
 * the sequence (0 once exhausted). Tracks connect()/release() so we can assert the
 * client is always returned.
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
            if (sql.startsWith('SELECT update_atomicmarket_stats_market')) {
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

describe('drainAtomicmarketStatsMarket', () => {
    it('loops until a batch releases 0 queue rows, summing the total released', async () => {
        const { pool, drainCalls } = makePool([1000, 1000, 137, 0]);
        const total = await drainAtomicmarketStatsMarket(pool, BATCH, 50_000, STMT_TIMEOUT_S, WORK_MEM_MB);

        expect(total).to.equal(2137);
        // 3 non-empty batches + 1 terminating empty batch
        expect(drainCalls()).to.equal(4);
    });

    it('keeps draining a batch that released rows but wrote no stats rows', async () => {
        // The function returns QUEUE ROWS RELEASED, not stats rows written (2.0.10),
        // precisely so a batch of already-current listings still reports progress. Had
        // it kept 1.3.15's write count, a backlog of unchanged listings would report 0
        // on the first batch and cap the burn-down at one batch per tick - which is the
        // rate the unbounded recompute already failed at.
        const { pool, drainCalls } = makePool([1000, 1000, 0]);
        const total = await drainAtomicmarketStatsMarket(pool, BATCH, 50_000, STMT_TIMEOUT_S, WORK_MEM_MB);

        expect(total).to.equal(2000);
        expect(drainCalls()).to.equal(3);
    });

    it('yields between batches when shouldYield() turns true, even with budget + backlog remaining', async () => {
        // What bounding the work buys: the single-statement recompute this replaces
        // could not be interrupted, so a reader falling behind mid-run waited out the
        // whole run. The gate is therefore re-checked BETWEEN batches, not only at tick
        // start (runGatedDrain).
        const { pool, drainCalls } = makePool([1000, 1000, 1000, 1000, 1000]);
        let calls = 0;
        const shouldYield = (): boolean => {
            calls += 1;
            return calls >= 2;
        };
        const total = await drainAtomicmarketStatsMarket(
            pool, BATCH, 10 * 60_000, STMT_TIMEOUT_S, WORK_MEM_MB, shouldYield,
        );

        expect(total).to.equal(2000); // exactly 2 batches before yielding
        expect(drainCalls()).to.equal(2);
    });

    it('makes exactly one call when the due queue is already empty', async () => {
        const { pool, drainCalls } = makePool([0]);
        const total = await drainAtomicmarketStatsMarket(pool, BATCH, 50_000, STMT_TIMEOUT_S, WORK_MEM_MB);

        expect(total).to.equal(0);
        expect(drainCalls()).to.equal(1);
    });

    it('stops at the time budget even if the backlog remains', async () => {
        // Always reports a full batch released (queue never drains). A clock that jumps
        // past the deadline after the second batch must stop the loop.
        const { pool, drainCalls } = makePool([1000, 1000, 1000, 1000, 1000]);
        let t = 0;
        const now = (): number => {
            const v = t;
            t += 20_000; // each read advances 20s
            return v;
        };
        // deadline = now() (=0) + 25_000. loop-check reads 20_000 (<25_000 -> continue),
        // next read 40_000 (stop). Exactly 2 batches before the budget tripped.
        const total = await drainAtomicmarketStatsMarket(
            pool, BATCH, 25_000, STMT_TIMEOUT_S, WORK_MEM_MB, () => false, now,
        );

        expect(total).to.equal(2000);
        expect(drainCalls()).to.equal(2);
    });

    it('coerces string released counts (pg returns the INT return value as a string in some drivers)', async () => {
        const { pool } = makePool(['1000', '0']);
        const total = await drainAtomicmarketStatsMarket(pool, BATCH, 50_000, STMT_TIMEOUT_S, WORK_MEM_MB);
        expect(total).to.equal(1000);
    });

    it('wraps each batch in its own txn with SET LOCAL work_mem / statement_timeout / async commit BEFORE the drain query', async () => {
        // The 57014 this migration fixes came from the pool's own 30s
        // connection-level statement_timeout, which PgBouncer transaction pooling is
        // the only timeout to let through. It must be raised per transaction with SET
        // LOCAL, and before the call: statement_timeout is armed when the statement
        // begins, so raising it from inside the function cannot extend a running call.
        const { pool, queries } = makePool([0]);
        await drainAtomicmarketStatsMarket(pool, BATCH, 50_000, STMT_TIMEOUT_S, WORK_MEM_MB);

        expect(queries).to.deep.equal([
            'BEGIN',
            "SET LOCAL work_mem = '256MB'",
            "SET LOCAL statement_timeout = '300s'",
            'SET LOCAL synchronous_commit = off',
            DRAIN_SQL,
            'COMMIT',
        ]);
    });

    it('binds the batch size as a parameter rather than interpolating it into the SQL', async () => {
        const { pool, queries, params } = makePool([0]);
        await drainAtomicmarketStatsMarket(pool, 37, 50_000, STMT_TIMEOUT_S, WORK_MEM_MB);

        expect(queries).to.include(DRAIN_SQL);
        expect(params).to.deep.equal([[37]]);
        expect(queries.some(q => q.includes('37'))).to.equal(false);
    });

    it('threads non-default work_mem and statement_timeout through to the SET LOCALs (env-override path)', async () => {
        const { pool, queries } = makePool([0]);
        await drainAtomicmarketStatsMarket(pool, BATCH, 50_000, 60, 512);

        expect(queries).to.include("SET LOCAL work_mem = '512MB'");
        expect(queries).to.include("SET LOCAL statement_timeout = '60s'");
        expect(queries).to.not.include("SET LOCAL work_mem = '256MB'");
        expect(queries).to.not.include("SET LOCAL statement_timeout = '300s'");
    });

    it('rolls back and rethrows when a batch errors, and always releases the client', async () => {
        let released = false;
        const queries: string[] = [];
        const client = {
            query: async (sql: string) => {
                queries.push(sql);
                if (sql.startsWith('SELECT update_atomicmarket_stats_market')) {
                    throw new Error('canceling statement due to statement timeout'); // 57014
                }
                return { rows: [] };
            },
            release: () => { released = true; },
        };
        const pool = { connect: async () => client };

        await expect(
            drainAtomicmarketStatsMarket(pool, BATCH, 50_000, STMT_TIMEOUT_S, WORK_MEM_MB),
        ).to.be.rejectedWith(/statement timeout/);

        expect(queries).to.include('ROLLBACK');
        expect(queries).to.not.include('COMMIT');
        expect(released).to.equal(true); // client returned to the pool even on error
    });

    it('returns the client to the pool after every batch, not just the last one', async () => {
        const { pool, releases } = makePool([1000, 1000, 0]);
        await drainAtomicmarketStatsMarket(pool, BATCH, 50_000, STMT_TIMEOUT_S, WORK_MEM_MB);

        expect(releases()).to.equal(3); // one connect/release pair per batch
    });
});

describe('STATS_MARKET_WORK_PROBE_SQL', () => {
    it('measures due-ness against the reader block time, never wall clock', () => {
        // An auction enqueues a boundary row at end_time * 1000 that the claim gates on
        // MAX(block_time). On a lagging filler block time and wall clock diverge by the
        // lag, so a wall-clock probe would report work the claim will not take and wake
        // an empty drain every tick.
        expect(STATS_MARKET_WORK_PROBE_SQL).to.match(/refresh_at\s*<=\s*\(SELECT MAX\(block_time\) FROM contract_readers\)/);
        expect(STATS_MARKET_WORK_PROBE_SQL).to.not.match(/now\(\)|CURRENT_TIMESTAMP|clock_timestamp|extract\s*\(\s*epoch/i);
    });

    it('is a cheap bounded EXISTS probe on the queue, not a count', () => {
        expect(STATS_MARKET_WORK_PROBE_SQL).to.match(/SELECT EXISTS\(/);
        expect(STATS_MARKET_WORK_PROBE_SQL).to.include('FROM atomicmarket_stats_markets_updates');
        expect(STATS_MARKET_WORK_PROBE_SQL).to.include('LIMIT 1');
        expect(STATS_MARKET_WORK_PROBE_SQL).to.include('AS has_work');
        expect(STATS_MARKET_WORK_PROBE_SQL).to.not.match(/count\(/i);
    });
});
