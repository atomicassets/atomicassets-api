import 'mocha';
import { expect } from 'chai';
import { Client, Pool } from 'pg';

import { getTestPostgresConfig } from '../../../utils/test';
import { createMockNotifier } from '../test-helper';
import DataProcessor, { ProcessingState } from '../../processor';
import { ModuleLoader } from '../../modules';
import AtomicAssetsHandler from './index';
import {
    clearFloatRepairState,
    floatRepairStateName,
    FLOAT_REPAIR_LOCK_NAME,
    loadFloatSchemas,
    readFloatRepairState,
    repairBatch,
    runFloatRepair,
    FloatSchema,
} from './float-repair';

// Integration coverage for the one-time float attribute repair: the rebuild
// rule per format kind, the non-finite rewrite, the guards that leave a value
// alone, the dbinfo cursor and its resume, the advisory-lock no-op, and the
// reader-priority gate on the job that drives it.
//
// These tests cannot use the txit BEGIN/ROLLBACK harness: the repair checks out
// its own client per batch, so it would never see rows written inside another
// connection's open transaction. Rows are committed under a contract name of
// this file's own and removed after each test.

const CONTRACT = 'fltrepair';
const COLLECTION = 'flrcol1';
const FLOAT_SCHEMA = 'flrsch1';
const PLAIN_SCHEMA = 'flrsch2';

const FLOAT_FORMAT = [
    { name: 'wear', type: 'float' },
    { name: 'score', type: 'double' },
    { name: 'vals', type: 'double[]' },
    { name: 'fvals', type: 'float[]' },
    { name: 'level', type: 'uint64' },
    { name: 'name', type: 'string' },
].map(entry => JSON.stringify(entry));

const PLAIN_FORMAT = [
    { name: 'score', type: 'string' },
].map(entry => JSON.stringify(entry));

type AssetSeed = {
    asset_id: number,
    schema_name: string,
    mutable_data: string | null,
    immutable_data: string | null,
};

// One seed covers every rebuild and guard proposition. Assets 3 and 5 carry the
// five values the guards refuse, assets 1, 2 and 5 are the three the pass
// rewrites, and asset 4 already holds numbers.
const ASSETS: AssetSeed[] = [
    {
        asset_id: 1,
        schema_name: FLOAT_SCHEMA,
        mutable_data: '{"score": "156.2", "wear": "1.0000001", "level": "12345678901234567890", "name": "keep"}',
        immutable_data: '{"wear": "0.5"}',
    },
    {
        asset_id: 2,
        schema_name: FLOAT_SCHEMA,
        mutable_data: '{"vals": ["1.5", "2"], "fvals": []}',
        immutable_data: '{"score": "1e-320"}',
    },
    {
        asset_id: 3,
        schema_name: FLOAT_SCHEMA,
        mutable_data: '{"score": "abc", "wear": "3.5e38"}',
        immutable_data: null,
    },
    {
        asset_id: 4,
        schema_name: FLOAT_SCHEMA,
        mutable_data: '{"score": 156.2}',
        immutable_data: '{"name": "already"}',
    },
    {
        asset_id: 5,
        schema_name: FLOAT_SCHEMA,
        mutable_data: '{"score": "1e400", "wear": "7e-46", "vals": ["0.0000", "-0"]}',
        immutable_data: '{"score": "1e-400"}',
    },
    {
        asset_id: 10,
        schema_name: PLAIN_SCHEMA,
        mutable_data: '{"score": "156.2"}',
        immutable_data: '{}',
    },
];

function createMockModuleLoader(): ModuleLoader {
    const loader = Object.create(ModuleLoader.prototype) as ModuleLoader;
    // @ts-ignore - override private field
    loader.modules = [];
    // @ts-ignore - override readonly field
    loader.names = [];
    return loader;
}

describe('atomicassets float attribute repair', () => {
    let client: Client;
    let pool: Pool;

    async function cleanup(): Promise<void> {
        await client.query('DELETE FROM atomicassets_assets WHERE contract = $1', [CONTRACT]);
        await client.query('DELETE FROM atomicassets_asset_counts WHERE contract = $1', [CONTRACT]);
        await client.query('DELETE FROM atomicmarket_sales_filters_updates WHERE asset_contract = $1', [CONTRACT]);
        await client.query('DELETE FROM atomicassets_schemas WHERE contract = $1', [CONTRACT]);
        await client.query('DELETE FROM atomicassets_collections WHERE contract = $1', [CONTRACT]);
        await client.query('DELETE FROM dbinfo WHERE name = $1', [floatRepairStateName(CONTRACT)]);
    }

    async function seed(): Promise<void> {
        await client.query(
            `INSERT INTO atomicassets_collections
                (contract, collection_name, author, allow_notify, authorized_accounts, notify_accounts, market_fee, data, created_at_block, created_at_time)
             VALUES ($1, $2, 'author', FALSE, '{}', '{}', 0, '{}', 1, 1)`,
            [CONTRACT, COLLECTION]
        );

        for (const [schema, format] of [[FLOAT_SCHEMA, FLOAT_FORMAT], [PLAIN_SCHEMA, PLAIN_FORMAT]] as Array<[string, string[]]>) {
            await client.query(
                `INSERT INTO atomicassets_schemas (contract, collection_name, schema_name, format, created_at_block, created_at_time)
                 VALUES ($1, $2, $3, $4::jsonb[], 1, 1)`,
                [CONTRACT, COLLECTION, schema, format]
            );
        }

        for (const asset of ASSETS) {
            await client.query(
                `INSERT INTO atomicassets_assets
                    (contract, asset_id, collection_name, schema_name, owner, mutable_data, immutable_data,
                     transferred_at_block, transferred_at_time, updated_at_block, updated_at_time, minted_at_block, minted_at_time)
                 VALUES ($1, $2, $3, $4, 'owner', $5, $6, 1, 1, 1, 1, 1, 1)`,
                [CONTRACT, asset.asset_id, COLLECTION, asset.schema_name, asset.mutable_data, asset.immutable_data]
            );
        }
    }

    async function readAsset(assetId: number): Promise<{ mutable_data: any, immutable_data: any }> {
        const query = await client.query(
            'SELECT mutable_data, immutable_data FROM atomicassets_assets WHERE contract = $1 AND asset_id = $2',
            [CONTRACT, assetId]
        );

        return query.rows[0];
    }

    async function jsonbTypeof(assetId: number, column: string, key: string): Promise<string> {
        const query = await client.query(
            `SELECT jsonb_typeof(${column} -> $3) AS kind FROM atomicassets_assets WHERE contract = $1 AND asset_id = $2`,
            [CONTRACT, assetId, key]
        );

        return query.rows[0].kind;
    }

    before(async () => {
        client = new Client(getTestPostgresConfig());
        await client.connect();
        pool = new Pool({ ...getTestPostgresConfig(), max: 2 });
    });

    after(async () => {
        await cleanup();
        await client.end();
        await pool.end();
    });

    beforeEach(async () => {
        await cleanup();
        await seed();
    });

    afterEach(async () => {
        await cleanup();
    });

    it('loads only the schemas whose format declares a float key, with the keys per kind', async () => {
        const schemas: FloatSchema[] = await loadFloatSchemas(client, CONTRACT);

        expect(schemas.length, 'only the float schema is returned').to.equal(1);
        expect(schemas[0].collection_name).to.equal(COLLECTION);
        expect(schemas[0].schema_name).to.equal(FLOAT_SCHEMA);
        expect(schemas[0].double_keys).to.deep.equal(['score']);
        expect(schemas[0].float_keys).to.deep.equal(['wear']);
        expect(schemas[0].double_vec_keys).to.deep.equal(['vals']);
        expect(schemas[0].float_vec_keys).to.deep.equal(['fvals']);
    });

    it('rewrites a double string to a number and a float string to the nearest float32', async () => {
        const result = await runFloatRepair(pool, CONTRACT, { pauseMs: 0 });

        expect(result.done, 'the pass completes').to.equal(true);

        const asset = await readAsset(1);
        expect(asset.mutable_data.score, 'the double string parses as a double').to.equal(156.2);
        expect(asset.mutable_data.wear, 'the float string rounds to the nearest float32').to.equal(1.0000001192092896);
        expect(asset.immutable_data.wear, 'the immutable column is rebuilt too').to.equal(0.5);

        expect(await jsonbTypeof(1, 'mutable_data', 'score')).to.equal('number');
        expect(await jsonbTypeof(1, 'mutable_data', 'wear')).to.equal('number');
        expect(await jsonbTypeof(1, 'immutable_data', 'wear')).to.equal('number');
    });

    it('rewrites a double[] element-wise and keeps an empty array empty', async () => {
        await runFloatRepair(pool, CONTRACT, { pauseMs: 0 });

        const asset = await readAsset(2);
        expect(asset.mutable_data.vals, 'every element converts, a number element is left as it is').to.deep.equal([1.5, 2]);
        expect(asset.mutable_data.fvals, 'an empty array stays an empty array').to.deep.equal([]);
        expect(await jsonbTypeof(2, 'mutable_data', 'fvals')).to.equal('array');
    });

    it('leaves every value the guards refuse in place, and counts each one', async () => {
        const result = await runFloatRepair(pool, CONTRACT, { pauseMs: 0 });

        expect(result.rejected, 'the five refused values across assets 3 and 5').to.equal(5);

        const nonNumeric = await readAsset(3);
        expect(nonNumeric.mutable_data.score, 'text is left alone').to.equal('abc');
        expect(nonNumeric.mutable_data.wear, 'a magnitude above the float32 range is left alone').to.equal('3.5e38');
        expect(await jsonbTypeof(3, 'mutable_data', 'score')).to.equal('string');
        expect(await jsonbTypeof(3, 'mutable_data', 'wear')).to.equal('string');

        // Both casts raise outside their own range at the bottom as well as the
        // top, so each of these three would abort the batch without the guard.
        const outOfRange = await readAsset(5);
        expect(outOfRange.mutable_data.score, 'a magnitude above the double range is left alone').to.equal('1e400');
        expect(outOfRange.mutable_data.wear, 'a magnitude below the smallest float32 subnormal is left alone').to.equal('7e-46');
        expect(outOfRange.immutable_data.score, 'a magnitude below the smallest double subnormal is left alone').to.equal('1e-400');
        expect(await jsonbTypeof(5, 'mutable_data', 'score')).to.equal('string');
        expect(await jsonbTypeof(5, 'mutable_data', 'wear')).to.equal('string');
        expect(await jsonbTypeof(5, 'immutable_data', 'score')).to.equal('string');

        const state = await readFloatRepairState(client, CONTRACT);
        expect(state.rejected, 'the state row carries the same count').to.equal(5);
    });

    it('converts a zero string and a subnormal double', async () => {
        await runFloatRepair(pool, CONTRACT, { pauseMs: 0 });

        const zeros = await readAsset(5);
        expect(zeros.mutable_data.vals, 'every spelling of zero reads back as the number zero').to.deep.equal([0, 0]);
        expect(await jsonbTypeof(5, 'mutable_data', 'vals')).to.equal('array');

        const subnormal = await readAsset(2);
        expect(subnormal.immutable_data.score, 'a subnormal double is inside the range and converts').to.equal(1e-320);
        expect(await jsonbTypeof(2, 'immutable_data', 'score')).to.equal('number');
    });

    it('leaves keys outside the float formats untouched and never touches a NULL document', async () => {
        await runFloatRepair(pool, CONTRACT, { pauseMs: 0 });

        const withOtherKeys = await readAsset(1);
        expect(withOtherKeys.mutable_data.level, 'a uint64 stays a decimal string').to.equal('12345678901234567890');
        expect(withOtherKeys.mutable_data.name, 'a string attribute is untouched').to.equal('keep');
        expect(await jsonbTypeof(1, 'mutable_data', 'level')).to.equal('string');

        const withNullColumn = await readAsset(3);
        expect(withNullColumn.immutable_data, 'a NULL document stays NULL').to.equal(null);

        const outsideFloatSchema = await readAsset(10);
        expect(outsideFloatSchema.mutable_data.score, 'a schema declaring no float key is never scanned').to.equal('156.2');
    });

    it('rebuilds the immutable column when mutable_data is NULL, and leaves the NULL alone', async () => {
        // Inserted directly rather than through ASSETS: every other test in this
        // file asserts exact scanned/rewritten counts against that shared seed,
        // and this row would shift every one of them.
        const assetId = 6;

        // A double key and a value exact in binary keep the assertion free of
        // any float32-rounding question, which is not what this test covers.
        await client.query(
            `INSERT INTO atomicassets_assets
                (contract, asset_id, collection_name, schema_name, owner, mutable_data, immutable_data,
                 transferred_at_block, transferred_at_time, updated_at_block, updated_at_time, minted_at_block, minted_at_time)
             VALUES ($1, $2, $3, $4, 'owner', NULL, $5, 1, 1, 1, 1, 1, 1)`,
            [CONTRACT, assetId, COLLECTION, FLOAT_SCHEMA, '{"score": "99.25"}']
        );

        await runFloatRepair(pool, CONTRACT, { pauseMs: 0 });

        const asset = await readAsset(assetId);
        expect(asset.mutable_data, 'the NULL mutable column stays NULL').to.equal(null);
        expect(asset.immutable_data.score, 'the sibling immutable column still rebuilds').to.equal(99.25);
        expect(await jsonbTypeof(assetId, 'immutable_data', 'score')).to.equal('number');
    });

    // The three spellings an antelope 1.x Float32 or Float64 wrapper produced
    // for a non-finite value. Each row is inserted per test rather than added
    // to ASSETS, because the tests above assert exact counts against that
    // shared seed. The pass therefore reports one non-finite value and the
    // seed's own five rejections, which is what separates the two counters.
    async function seedNonFinite(assetId: number, mutableData: string): Promise<void> {
        await client.query(
            `INSERT INTO atomicassets_assets
                (contract, asset_id, collection_name, schema_name, owner, mutable_data, immutable_data,
                 transferred_at_block, transferred_at_time, updated_at_block, updated_at_time, minted_at_block, minted_at_time)
             VALUES ($1, $2, $3, $4, 'owner', $5, '{}', 1, 1, 1, 1, 1, 1)`,
            [CONTRACT, assetId, COLLECTION, FLOAT_SCHEMA, mutableData]
        );
    }

    it('rewrites a float NaN string to JSON null and counts it apart from a rejection', async () => {
        await seedNonFinite(7, '{"wear": "NaN"}');

        const result = await runFloatRepair(pool, CONTRACT, { pauseMs: 0 });

        expect(result.non_finite, 'the pass counts the one non-finite value').to.equal(1);
        expect(result.rejected, 'and leaves the rejection count at the seed\'s five').to.equal(5);

        const asset = await readAsset(7);
        expect(asset.mutable_data, 'the key survives, holding JSON null').to.deep.equal({ wear: null });
        expect(await jsonbTypeof(7, 'mutable_data', 'wear'), 'JSON null, not a dropped key').to.equal('null');

        const state = await readFloatRepairState(client, CONTRACT);
        expect(state.non_finite, 'the state row carries the same count').to.equal(1);
    });

    it('rewrites a double Infinity string to JSON null and counts it apart from a rejection', async () => {
        await seedNonFinite(8, '{"score": "Infinity"}');

        const result = await runFloatRepair(pool, CONTRACT, { pauseMs: 0 });

        expect(result.non_finite, 'the pass counts the one non-finite value').to.equal(1);
        expect(result.rejected, 'and leaves the rejection count at the seed\'s five').to.equal(5);

        const asset = await readAsset(8);
        expect(asset.mutable_data, 'the key survives, holding JSON null').to.deep.equal({ score: null });
        expect(await jsonbTypeof(8, 'mutable_data', 'score'), 'JSON null, not a dropped key').to.equal('null');

        const state = await readFloatRepairState(client, CONTRACT);
        expect(state.non_finite, 'the state row carries the same count').to.equal(1);
    });

    it('rewrites a float -Infinity string to JSON null and counts it apart from a rejection', async () => {
        await seedNonFinite(9, '{"wear": "-Infinity"}');

        const result = await runFloatRepair(pool, CONTRACT, { pauseMs: 0 });

        expect(result.non_finite, 'the pass counts the one non-finite value').to.equal(1);
        expect(result.rejected, 'and leaves the rejection count at the seed\'s five').to.equal(5);

        const asset = await readAsset(9);
        expect(asset.mutable_data, 'the key survives, holding JSON null').to.deep.equal({ wear: null });
        expect(await jsonbTypeof(9, 'mutable_data', 'wear'), 'JSON null, not a dropped key').to.equal('null');

        const state = await readFloatRepairState(client, CONTRACT);
        expect(state.non_finite, 'the state row carries the same count').to.equal(1);
    });

    it('rewrites zero rows on a second run and reports done', async () => {
        const first = await runFloatRepair(pool, CONTRACT, { pauseMs: 0 });
        expect(first.rewritten, 'the first pass rewrites the three assets holding convertible strings').to.equal(3);

        const second = await runFloatRepair(pool, CONTRACT, { pauseMs: 0 });
        expect(second.done, 'the stored state reports the pass complete').to.equal(true);
        expect(second.rewritten, 'nothing is written again').to.equal(0);

        // A restart re-reads every row rather than trusting the state, which is
        // what proves the statement itself is idempotent.
        const replay = await runFloatRepair(pool, CONTRACT, { pauseMs: 0, restart: true });
        expect(replay.done).to.equal(true);
        expect(replay.scanned, 'the replay walks the same assets').to.equal(5);
        expect(replay.rewritten, 'a document already holding numbers is not written again').to.equal(0);
    });

    it('resumes from the dbinfo cursor after an interrupted slice, and restart discards it', async () => {
        const slice = await runFloatRepair(pool, CONTRACT, { pauseMs: 0, batchSize: 1, maxBatches: 1 });

        expect(slice.done, 'the slice spends its budget before the pass completes').to.equal(false);
        expect(slice.scanned).to.equal(1);

        const cursor = await readFloatRepairState(client, CONTRACT);
        expect(cursor.status).to.equal('running');
        expect(cursor.collection_name).to.equal(COLLECTION);
        expect(cursor.schema_name).to.equal(FLOAT_SCHEMA);
        expect(cursor.asset_id, 'the cursor sits on the last asset of the batch').to.equal('1');

        expect((await readAsset(1)).mutable_data.score, 'the first asset is repaired').to.equal(156.2);
        expect((await readAsset(2)).mutable_data.vals, 'the second asset is untouched so far').to.deep.equal(['1.5', '2']);

        const rest = await runFloatRepair(pool, CONTRACT, { pauseMs: 0 });
        expect(rest.done, 'the continuation completes the pass').to.equal(true);
        expect(rest.scanned, 'it resumes after the cursor rather than from the first asset').to.equal(4);
        expect((await readAsset(2)).mutable_data.vals).to.deep.equal([1.5, 2]);

        // A rolled-back decoder writes strings again while the state still reads
        // done. Only the restart option covers those rows.
        await client.query(
            'UPDATE atomicassets_assets SET mutable_data = $3 WHERE contract = $1 AND asset_id = $2',
            [CONTRACT, 1, '{"score": "42.5"}']
        );

        const afterDone = await runFloatRepair(pool, CONTRACT, { pauseMs: 0 });
        expect(afterDone.rewritten, 'a completed pass does not read the table again').to.equal(0);
        expect((await readAsset(1)).mutable_data.score).to.equal('42.5');

        const restarted = await runFloatRepair(pool, CONTRACT, { pauseMs: 0, restart: true });
        expect(restarted.done).to.equal(true);
        expect(restarted.rewritten, 'the restart covers the row written after the pass').to.equal(1);
        expect((await readAsset(1)).mutable_data.score).to.equal(42.5);
    });

    it('returns skipped without writing when the advisory lock is held elsewhere', async () => {
        const holder = new Client(getTestPostgresConfig());
        await holder.connect();

        try {
            await holder.query('BEGIN');
            await holder.query('SELECT pg_advisory_xact_lock(hashtext($1))', [FLOAT_REPAIR_LOCK_NAME]);

            const schemas = await loadFloatSchemas(client, CONTRACT);
            const batchClient = await pool.connect();

            try {
                const batch = await repairBatch(batchClient, CONTRACT, schemas[0], '0', 500);
                expect(batch.skipped, 'the batch reports the lock was held').to.equal(true);
                expect(batch.rewritten).to.equal(0);
            } finally {
                batchClient.release();
            }

            const result = await runFloatRepair(pool, CONTRACT, { pauseMs: 0 });
            expect(result.skipped, 'the slice ends on the lock').to.equal(true);
            expect(result.done, 'and never marks the pass complete').to.equal(false);

            expect((await readAsset(1)).mutable_data.score, 'nothing was written').to.equal('156.2');
            expect(await readFloatRepairState(client, CONTRACT), 'no cursor row was written').to.equal(null);

            await holder.query('ROLLBACK');

            const unblocked = await runFloatRepair(pool, CONTRACT, { pauseMs: 0 });
            expect(unblocked.done, 'the same call completes once the lock is free').to.equal(true);
            expect((await readAsset(1)).mutable_data.score).to.equal(156.2);
        } finally {
            await holder.end().catch(() => undefined);
        }
    });

    it('drops a row a concurrent write already changed instead of reverting it', async () => {
        // A second connection holds asset 1's row lock, uncommitted, with the
        // value a fixed decoder would have written. repairBatch's own snapshot
        // (the batch CTE) is a plain read, so it still sees the pre-image and
        // computes its rebuild from that. Its UPDATE then blocks on the row
        // lock until the write below commits, which is what exercises the
        // read-committed re-check the WHERE addition guards.
        const writer = new Client(getTestPostgresConfig());
        await writer.connect();

        try {
            await writer.query('BEGIN');
            await writer.query(
                'UPDATE atomicassets_assets SET mutable_data = $3 WHERE contract = $1 AND asset_id = $2',
                [CONTRACT, 1, '{"score": 999.5}']
            );

            const schemas = await loadFloatSchemas(client, CONTRACT);
            const batchClient = await pool.connect();

            try {
                const batchPromise = repairBatch(batchClient, CONTRACT, schemas[0], '0', 1);

                // Gives repairBatch's UPDATE time to reach and block on asset 1's
                // row lock before the write below commits over it. The batch's
                // own read of asset 1 (a plain SELECT) is unaffected either way,
                // since a reader never blocks on an uncommitted writer.
                await new Promise(resolve => setTimeout(resolve, 300));

                await writer.query('COMMIT');

                const batch = await batchPromise;
                expect(batch.scanned, 'the row is still read into the batch').to.equal(1);
                expect(batch.rewritten, 'the concurrently-written row is not counted as rewritten').to.equal(0);
            } finally {
                batchClient.release();
            }

            const asset = await readAsset(1);
            expect(asset.mutable_data, 'the concurrent write survives, not the stale rebuild').to.deep.equal({ score: 999.5 });
        } finally {
            await writer.end().catch(() => undefined);
        }
    });

    describe('the filler job', () => {
        // The job callback is a closure inside register(), so it is captured
        // through a stubbed job queue. The pool it is handed records every
        // checkout and query before delegating to the real one, which is what
        // makes "returns without a query" an assertion rather than a claim.
        async function registerHandler(deferDrain: () => boolean): Promise<{
            run: () => Promise<void>,
            calls: string[],
            destroy: () => any,
        }> {
            const calls: string[] = [];
            const recordingPool: any = {
                connect: (): any => {
                    calls.push('connect');

                    return pool.connect();
                },
                query: (...args: any[]): any => {
                    calls.push('query');

                    return (pool as any).query(...args);
                },
                end: async (): Promise<void> => undefined,
            };

            const jobs: Array<{ name: string, interval: number, priority: number, fn: () => any }> = [];

            const handler: any = Object.create(AtomicAssetsHandler.prototype);
            Object.assign(handler, {
                args: { atomicassets_account: CONTRACT, store_transfers: false, store_logs: false },
                config: { collection_format: [], supported_tokens: [] },
                connection: { database: { createPool: (): any => recordingPool } },
                filler: {
                    jobs: {
                        add: (name: string, interval: number, priority: number, fn: () => any): void => {
                            jobs.push({ name, interval, priority, fn });
                        },
                    },
                    shouldDeferDrain: deferDrain,
                    reader: { lastIrreversibleBlock: 1 },
                },
            });

            const processor = new DataProcessor(ProcessingState.HEAD, createMockModuleLoader());
            const destroy = await handler.register(processor, createMockNotifier());

            const job = jobs.find(entry => entry.name === 'repair_atomicassets_float_attributes');
            expect(job, 'the repair job is registered').to.not.equal(undefined);
            expect(job.interval, 'it runs every 15 seconds').to.equal(15);
            expect(job.priority, 'at the lowest job priority').to.equal(3);

            return { run: async (): Promise<void> => { await job.fn(); }, calls, destroy };
        }

        it('returns without a query while shouldDeferDrain is true', async () => {
            const registered = await registerHandler(() => true);

            try {
                await registered.run();

                expect(registered.calls, 'the gated job never reaches the database').to.deep.equal([]);
                expect((await readAsset(1)).mutable_data.score, 'and writes nothing').to.equal('156.2');
            } finally {
                registered.destroy();
            }
        });

        it('runs a slice and stops querying once the pass reports done', async () => {
            const registered = await registerHandler(() => false);

            try {
                await registered.run();

                expect(registered.calls.length, 'the ungated job works the repair').to.be.greaterThan(0);
                expect((await readAsset(1)).mutable_data.score).to.equal(156.2);

                const afterFirstRun = registered.calls.length;
                await registered.run();

                expect(registered.calls.length, 'the in-memory done flag stops the next tick').to.equal(afterFirstRun);
            } finally {
                registered.destroy();
            }
        });

        it('starts over after the stored state is cleared', async () => {
            await runFloatRepair(pool, CONTRACT, { pauseMs: 0 });
            await client.query(
                'UPDATE atomicassets_assets SET mutable_data = $3 WHERE contract = $1 AND asset_id = $2',
                [CONTRACT, 1, '{"score": "42.5"}']
            );

            await clearFloatRepairState(client, CONTRACT);

            const registered = await registerHandler(() => false);

            try {
                await registered.run();

                expect((await readAsset(1)).mutable_data.score, 'a fresh filler picks the pass up again').to.equal(42.5);
            } finally {
                registered.destroy();
            }
        });
    });
});
