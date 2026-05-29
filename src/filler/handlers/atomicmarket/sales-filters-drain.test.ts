import 'mocha';
import { expect } from 'chai';

import { drainAtomicmarketSalesFilters } from './index';

/** Minimal pool stub: each query() returns the next queued `consumed` count. */
function poolReturning(consumedSequence: number[]): { pool: any; calls: () => number } {
    let i = 0;
    const pool = {
        query: async (_sql: string, _params?: any[]) => {
            const consumed = consumedSequence[i] ?? 0;
            i += 1;
            return { rows: [{ consumed }] };
        },
    };
    return { pool, calls: () => i };
}

describe('drainAtomicmarketSalesFilters', () => {
    it('loops until a call consumes 0 rows, summing total consumed', async () => {
        const { pool, calls } = poolReturning([5000, 5000, 1200, 0]);
        const total = await drainAtomicmarketSalesFilters(pool, 5000, 30_000, () => 0);

        expect(total).to.equal(11_200);
        // 3 non-empty batches + 1 terminating empty batch
        expect(calls()).to.equal(4);
    });

    it('makes exactly one call when the queue is already empty', async () => {
        const { pool, calls } = poolReturning([0]);
        const total = await drainAtomicmarketSalesFilters(pool, 5000, 30_000, () => 0);

        expect(total).to.equal(0);
        expect(calls()).to.equal(1);
    });

    it('stops at the time budget even if rows remain', async () => {
        // Always reports a full batch consumed (queue never drains). A clock that
        // jumps past the deadline after the first batch must stop the loop.
        const pool = { query: async () => ({ rows: [{ consumed: 5000 }] }) };
        let t = 0;
        const now = (): number => {
            const v = t;
            t += 20_000; // each read advances 20s
            return v;
        };
        // deadline = now() (=0) + 25_000 = 25_000. Reads: deadline uses t=0,
        // loop-check reads t=20_000 (<25_000 -> continue), next t=40_000 (stop).
        const total = await drainAtomicmarketSalesFilters(pool, 5000, 25_000, now);

        expect(total).to.equal(10_000); // exactly 2 batches before the budget tripped
    });

    it('coerces string consumed counts (pg may return bigint/numeric as string)', async () => {
        const seq = ['5000', '0'];
        let i = 0;
        const stringPool = {
            query: async () => ({ rows: [{ consumed: seq[i++] ?? '0' }] }),
        };
        const total = await drainAtomicmarketSalesFilters(stringPool as any, 5000, 30_000, () => 0);
        expect(total).to.equal(5000);
    });
});
