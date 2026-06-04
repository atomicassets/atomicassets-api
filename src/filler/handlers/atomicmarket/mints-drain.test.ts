import 'mocha';
import { expect } from 'chai';

import { drainAtomicmarketMints, mintsWorkProbeSql, MINTS_WORK_FILTER } from './index';

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
        const total = await drainAtomicmarketMints(pool, FN, CONTRACT, LIB, BATCH, 30_000);

        expect(total).to.equal(4350);
        // 3 non-empty batches + 1 terminating empty batch
        expect(calls()).to.equal(4);
    });

    it('yields between batches when shouldYield() turns true, even with budget + rows remaining', async () => {
        const { pool, calls } = makePool([2000, 2000, 2000, 2000]);
        let n = 0;
        const shouldYield = (): boolean => {
            n += 1;
            return n >= 2; // false after batch 1, true after batch 2
        };
        const total = await drainAtomicmarketMints(pool, FN, CONTRACT, LIB, BATCH, 10 * 60_000, shouldYield);

        expect(total).to.equal(4000); // 2 batches before yielding
        expect(calls()).to.equal(2);
    });

    it('makes exactly one call when nothing is resolvable (first batch 0)', async () => {
        const { pool, calls } = makePool([0]);
        const total = await drainAtomicmarketMints(pool, FN, CONTRACT, LIB, BATCH, 30_000);

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
        const total = await drainAtomicmarketMints(pool, FN, CONTRACT, LIB, BATCH, 25_000, () => false, now);

        expect(total).to.equal(4000);
    });

    it('coerces string counts (pg may return bigint/numeric as string)', async () => {
        const { pool } = makePool(['2000', '0']);
        const total = await drainAtomicmarketMints(pool, FN, CONTRACT, LIB, BATCH, 30_000);
        expect(total).to.equal(2000);
    });

    it('calls the named function with (contract, lib, batchSize) bound params', async () => {
        const { pool, queries } = makePool([0]);
        await drainAtomicmarketMints(pool, FN, CONTRACT, LIB, BATCH, 30_000);

        expect(queries[0].sql).to.equal(`SELECT ${FN}($1, $2, $3) AS updated`);
        expect(queries[0].params).to.deep.equal([CONTRACT, LIB, BATCH]);
    });

    it('rethrows when a batch query errors', async () => {
        const pool = {
            query: async () => { throw new Error('canceling statement due to statement timeout'); },
        };
        await expect(
            drainAtomicmarketMints(pool, FN, CONTRACT, LIB, BATCH, 30_000),
        ).to.be.rejectedWith(/statement timeout/);
    });

    it('refuses an fnName outside the allowlist (no query issued)', async () => {
        let called = false;
        const pool = { query: async () => { called = true; return { rows: [{ updated: 0 }] }; } };
        await expect(
            drainAtomicmarketMints(pool, 'evil(); DROP TABLE atomicmarket_sales; --', CONTRACT, LIB, BATCH, 30_000),
        ).to.be.rejectedWith(/unknown function/);
        expect(called).to.equal(false);
    });

    it('accepts update_atomicmarket_template_buyoffer_mints (4th drain, in the allowlist)', async () => {
        // Regression guard: this routine was dormant for years (never in the
        // allowlist, never scheduled). It must drain through the same harness as
        // the other three — in the allowlist (no `unknown function` throw) and
        // bound with the generic (contract, lib, batchSize) shape.
        const TBO_FN = 'update_atomicmarket_template_buyoffer_mints';
        const { pool, queries } = makePool([2000, 0]);
        const total = await drainAtomicmarketMints(pool, TBO_FN, CONTRACT, LIB, BATCH, 30_000);

        expect(total).to.equal(2000);
        expect(queries[0].sql).to.equal(`SELECT ${TBO_FN}($1, $2, $3) AS updated`);
        expect(queries[0].params).to.deep.equal([CONTRACT, LIB, BATCH]);
    });
});

describe('mintsWorkProbeSql', () => {
    it('gates template_buyoffers on state = 2 (only SOLD rows own an nft)', () => {
        // The whole point of the template_buyoffers fix: the probe must match the
        // drain FUNCTION's `state = 2` filter, or it matches the millions of
        // never-mintable non-SOLD nulls and the gate never reports no-work.
        const sql = mintsWorkProbeSql('atomicmarket_template_buyoffers');
        expect(sql).to.match(/FROM atomicmarket_template_buyoffers\b/);
        expect(sql).to.contain('AND state = 2');
    });

    it('does NOT add a state filter for sales / buyoffers / auctions', () => {
        for (const table of ['atomicmarket_sales', 'atomicmarket_buyoffers', 'atomicmarket_auctions'] as const) {
            const sql = mintsWorkProbeSql(table);
            expect(sql, table).to.match(new RegExp(`FROM ${table}\\b`));
            expect(sql, table).to.not.contain('state');
        }
    });

    it('always probes on the unresolved-mint predicate, bound by contract + LIB', () => {
        for (const table of Object.keys(MINTS_WORK_FILTER) as Array<keyof typeof MINTS_WORK_FILTER>) {
            const sql = mintsWorkProbeSql(table);
            expect(sql, table).to.contain('template_mint IS NULL');
            expect(sql, table).to.contain('market_contract = $1');
            expect(sql, table).to.contain('created_at_block <= $2');
            expect(sql, table).to.contain('LIMIT 1');
        }
    });
});
