import 'mocha';
import { expect } from 'chai';
import * as sinon from 'sinon';

import { extractNotificationBlocks, readNotifiedRows } from './notification-read';
import { NotificationData } from '../filler/notification-format';
import logger from '../utils/winston';

type ScriptedDb = {
    db: any,
    queries: () => number
};

// Each entry of `resultSets` answers one query, in order; the last entry
// answers every further query, so a scenario states only the reads it varies.
function scriptedDb(resultSets: any[][]): ScriptedDb {
    let queries = 0;

    return {
        db: {
            query: async (): Promise<{rows: any[]}> => {
                const rows = resultSets[Math.min(queries, resultSets.length - 1)];

                queries += 1;

                return {rows};
            }
        },
        queries: (): number => queries
    };
}

function recordedSleep(): {sleep: (ms: number) => Promise<void>, delays: number[]} {
    const delays: number[] = [];

    return {
        sleep: async (ms: number): Promise<void> => {
            delays.push(ms);
        },
        delays
    };
}

function traceNotification(blockNum: number, data: any): NotificationData {
    return {
        channel: 'sales',
        type: 'trace',
        data: {
            block: {block_num: blockNum} as any,
            tx: {id: 'a'.repeat(64), cpu_usage_us: 100, net_usage_words: 10, traces: []},
            trace: {
                action_ordinal: 1,
                creator_action_ordinal: 0,
                global_sequence: '1',
                account_ram_deltas: [],
                act: {account: 'atomicmarket', name: 'purchasesale', authorization: [], data}
            } as any
        }
    };
}

function deltaNotification(blockNum: number, value: any): NotificationData {
    return {
        channel: 'sales',
        type: 'delta',
        data: {
            block: {block_num: blockNum} as any,
            delta: {code: 'atomicmarket', scope: 'atomicmarket', table: 'sales', primary_key: '1', payer: 'a', present: true, value} as any
        }
    };
}

function forkNotification(blockNum: number): NotificationData {
    return {channel: null, type: 'fork', data: {block: {block_num: blockNum} as any}} as any;
}

function saleRead(overrides: any = {}): any {
    return {
        sql: 'SELECT * FROM atomicmarket_sales_master WHERE sale_id = ANY($1)',
        params: [['1']],
        ids: [1],
        keyOf: (row: any) => row.sale_id,
        blockOf: (row: any) => row.updated_at_block,
        channel: 'sales',
        attempts: 3,
        delayMs: 100,
        ...overrides
    };
}

describe('extractNotificationBlocks', () => {
    it('reads the identifier out of an action payload', () => {
        const blocks = extractNotificationBlocks([traceNotification(500, {sale_id: 7})], 'sale_id');

        expect([...blocks.entries()]).to.deep.equal([['7', 500]]);
    });

    it('reads the identifier out of a delta row', () => {
        const blocks = extractNotificationBlocks([deltaNotification(500, {sale_id: 7})], 'sale_id');

        expect([...blocks.entries()]).to.deep.equal([['7', 500]]);
    });

    it('keeps the highest block reported for one identifier', () => {
        const blocks = extractNotificationBlocks([
            traceNotification(500, {sale_id: 7}),
            traceNotification(504, {sale_id: 7}),
            traceNotification(502, {sale_id: 7})
        ], 'sale_id');

        expect(blocks.get('7')).to.equal(504);
    });

    it('takes the identifier from a function when one is given', () => {
        const blocks = extractNotificationBlocks(
            [traceNotification(500, {sale_id: 7})],
            notification => notification.data.trace?.global_sequence
        );

        expect([...blocks.entries()]).to.deep.equal([['1', 500]]);
    });

    it('contributes no identifier for a fork notification', () => {
        const blocks = extractNotificationBlocks([forkNotification(500)], 'sale_id');

        expect(blocks.size).to.equal(0);
    });

    it('contributes no expectation when a function identifier returns undefined', () => {
        const blocks = extractNotificationBlocks([traceNotification(500, {sale_id: 7})], () => undefined);

        expect(blocks.size).to.equal(0);
    });
});

describe('readNotifiedRows', () => {
    // A local sandbox, so tearing down this file's logger stub cannot unwrap a
    // stub another spec file installed on the same module.
    const sandbox = sinon.createSandbox();

    afterEach(() => {
        sandbox.restore();
    });

    it('returns after one query and never sleeps when every row is at the notified block', async () => {
        const {db, queries} = scriptedDb([[{sale_id: '1', updated_at_block: '500'}]]);
        const {sleep, delays} = recordedSleep();

        const rows = await readNotifiedRows(db, saleRead({
            expectedBlockById: new Map([['1', 500]]),
            sleep
        }));

        expect(rows).to.deep.equal([{sale_id: '1', updated_at_block: '500'}]);
        expect(queries()).to.equal(1);
        expect(delays).to.deep.equal([]);
    });

    it('re-reads a row whose block is behind the notified block and returns the caught-up row', async () => {
        const {db, queries} = scriptedDb([
            [{sale_id: '1', updated_at_block: '499'}],
            [{sale_id: '1', updated_at_block: '500'}]
        ]);
        const {sleep, delays} = recordedSleep();

        const rows = await readNotifiedRows(db, saleRead({
            expectedBlockById: new Map([['1', 500]]),
            sleep
        }));

        expect(rows).to.deep.equal([{sale_id: '1', updated_at_block: '500'}]);
        expect(queries()).to.equal(2);
        expect(delays).to.deep.equal([100]);
    });

    it('keeps reading until every identifier catches up, not just the first', async () => {
        const {db, queries} = scriptedDb([
            [{sale_id: '1', updated_at_block: '500'}, {sale_id: '2', updated_at_block: '499'}],
            [{sale_id: '1', updated_at_block: '500'}, {sale_id: '2', updated_at_block: '500'}]
        ]);
        const {sleep, delays} = recordedSleep();

        const rows = await readNotifiedRows(db, saleRead({
            ids: [1, 2],
            expectedBlockById: new Map([['1', 500], ['2', 500]]),
            sleep
        }));

        expect(rows).to.deep.equal([
            {sale_id: '1', updated_at_block: '500'},
            {sale_id: '2', updated_at_block: '500'}
        ]);
        expect(queries()).to.equal(2);
        expect(delays).to.deep.equal([100]);
    });

    it('re-reads an identifier that has no row yet and returns the row once it arrives', async () => {
        const {db, queries} = scriptedDb([
            [],
            [{sale_id: '1', updated_at_block: '500'}]
        ]);
        const {sleep, delays} = recordedSleep();

        const rows = await readNotifiedRows(db, saleRead({
            expectedBlockById: new Map([['1', 500]]),
            sleep
        }));

        expect(rows).to.deep.equal([{sale_id: '1', updated_at_block: '500'}]);
        expect(queries()).to.equal(2);
        expect(delays).to.deep.equal([100]);
    });

    it('returns the rows it has and logs one warning once the attempts are spent', async () => {
        const warnSpy = sandbox.stub(logger, 'warn');
        const {db, queries} = scriptedDb([[{sale_id: '1', updated_at_block: '499'}]]);
        const {sleep, delays} = recordedSleep();

        const rows = await readNotifiedRows(db, saleRead({
            expectedBlockById: new Map([['1', 500]]),
            sleep
        }));

        expect(rows).to.deep.equal([{sale_id: '1', updated_at_block: '499'}]);
        expect(queries()).to.equal(3);
        expect(delays).to.deep.equal([100, 100]);
        expect(warnSpy.calledOnce).to.equal(true);
        expect(warnSpy.firstCall.args[1]).to.deep.equal({
            channel: 'sales',
            ids: ['1'],
            expected_block: 500,
            attempts: 3,
            suppressed_batches: 0
        });
    });

    it('does not re-read for an identifier no notification reports a block for', async () => {
        const {db, queries} = scriptedDb([[]]);
        const {sleep, delays} = recordedSleep();

        const rows = await readNotifiedRows(db, saleRead({
            expectedBlockById: new Map(),
            sleep
        }));

        expect(rows).to.deep.equal([]);
        expect(queries()).to.equal(1);
        expect(delays).to.deep.equal([]);
    });

    it('counts a row as fresh when blockOf combines two columns', async () => {
        const row = {sale_id: '1', updated_at_block: '499', backed_at_block: '500'};
        const {db, queries} = scriptedDb([[row]]);
        const {sleep, delays} = recordedSleep();

        const rows = await readNotifiedRows(db, saleRead({
            expectedBlockById: new Map([['1', 500]]),
            blockOf: (candidate: any) => Math.max(Number(candidate.updated_at_block), Number(candidate.backed_at_block ?? 0)),
            sleep
        }));

        expect(rows).to.deep.equal([row]);
        expect(queries()).to.equal(1);
        expect(delays).to.deep.equal([]);
    });

    // The warn throttle keeps its state per channel for the life of the
    // process, so each test below claims a channel name of its own rather than
    // inheriting what an earlier test left behind.
    it('throttles a second exhausted batch inside the window and counts it on the next line', async () => {
        const warnSpy = sandbox.stub(logger, 'warn');
        const {sleep} = recordedSleep();
        let now = 1000;

        const behindRead = (): any => saleRead({
            channel: 'sales_window',
            expectedBlockById: new Map([['1', 500]]),
            sleep,
            clock: (): number => now
        });

        await readNotifiedRows(scriptedDb([[{sale_id: '1', updated_at_block: '499'}]]).db, behindRead());

        now += 30000;

        await readNotifiedRows(scriptedDb([[{sale_id: '1', updated_at_block: '499'}]]).db, behindRead());

        expect(warnSpy.calledOnce).to.equal(true);
        expect(warnSpy.firstCall.args[1].suppressed_batches).to.equal(0);

        now += 60000;

        await readNotifiedRows(scriptedDb([[{sale_id: '1', updated_at_block: '499'}]]).db, behindRead());

        expect(warnSpy.calledTwice).to.equal(true);
        expect(warnSpy.secondCall.args[1]).to.deep.equal({
            channel: 'sales_window',
            ids: ['1'],
            expected_block: 500,
            attempts: 3,
            suppressed_batches: 1
        });
    });

    it('warns for each channel independently', async () => {
        const warnSpy = sandbox.stub(logger, 'warn');
        const {sleep} = recordedSleep();

        const behindRead = (channel: string): any => saleRead({
            channel,
            expectedBlockById: new Map([['1', 500]]),
            sleep,
            clock: (): number => 5000
        });

        await readNotifiedRows(scriptedDb([[{sale_id: '1', updated_at_block: '499'}]]).db, behindRead('sales_pair'));
        await readNotifiedRows(scriptedDb([[{sale_id: '1', updated_at_block: '499'}]]).db, behindRead('auctions_pair'));

        expect(warnSpy.calledTwice).to.equal(true);
        expect(warnSpy.firstCall.args[1].channel).to.equal('sales_pair');
        expect(warnSpy.secondCall.args[1].channel).to.equal('auctions_pair');
    });
});
