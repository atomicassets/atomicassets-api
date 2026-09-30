import 'mocha';
import { expect } from 'chai';
import * as sinon from 'sinon';
import { Client } from 'pg';
import {
    createProcessorTestContext,
    createBlock,
    createTx,
    createActionTrace,
    createTestTransaction,
} from '../../test-helper';
import { assetProcessor } from './assets';
import SimpleAssetsHandler from '../index';
import DataProcessor, { ProcessingState } from '../../../processor';
import { ContractDBTransaction } from '../../../database';
import { ModuleLoader } from '../../../modules';
import { ShipBlock } from '../../../../types/ship';
import logger from '../../../../utils/winston';

const CONTRACT = 'simpleassets';
const GPK = 'gpk.topps';
const GROUP_FIELDS = ['cardid', 'quality', 'variant'];

function createMockCore(overrides: Record<string, any> = {}): any {
    return {
        args: {
            simpleassets_account: CONTRACT,
            store_transfers: false,
            numbered_authors: [GPK],
            numbered_group_fields: GROUP_FIELDS,
            ...overrides,
        },
    };
}

function createMockModuleLoader(): ModuleLoader {
    const loader = Object.create(ModuleLoader.prototype) as ModuleLoader;
    // @ts-ignore
    loader.modules = [];
    // @ts-ignore
    loader.names = [];
    return loader;
}

function blockAt(blockNum: number): ShipBlock {
    return createBlock({ block_num: blockNum });
}

type TraceInput = { block: ShipBlock, name: string, data: Record<string, any> };

function createlog(block: number, assetid: string, overrides: Record<string, any> = {}): TraceInput {
    const mdata = overrides.mdata ?? { cardid: 1, quality: 'common', variant: 'base' };

    return {
        block: blockAt(block),
        name: 'createlog',
        data: {
            author: overrides.author ?? GPK,
            category: overrides.category ?? 'series1',
            owner: overrides.owner ?? 'alice',
            idata: '{}',
            mdata: JSON.stringify(mdata),
            assetid,
            requireclaim: false,
        },
    };
}

describe('simpleassets assetProcessor', () => {
    let client: Client;
    let processor: DataProcessor;
    let db: ContractDBTransaction;
    let destroyProcessor: (() => any) | null = null;

    before(async () => {
        const ctx = createProcessorTestContext();
        client = ctx.client;
        await client.connect();
    });

    after(async () => {
        await client.end();
    });

    function register(coreOverrides: Record<string, any> = {}): void {
        if (destroyProcessor) {
            destroyProcessor();
        }

        processor = new DataProcessor(ProcessingState.HEAD, createMockModuleLoader());
        destroyProcessor = assetProcessor(createMockCore(coreOverrides) as any, processor);
    }

    beforeEach(async () => {
        await client.query('BEGIN');
        db = createTestTransaction(client);
        register();
        await setBaseline(1000);
    });

    afterEach(async () => {
        sinon.restore();
        if (destroyProcessor) {
            destroyProcessor();
            destroyProcessor = null;
        }
        await client.query('ROLLBACK');
    });

    // One filler commit batch: every trace is queued, then the head queue runs once.
    async function runBatch(traces: TraceInput[]): Promise<void> {
        for (const trace of traces) {
            processor.processActionTrace(trace.block, createTx(), createActionTrace(CONTRACT, trace.name, trace.data));
        }

        await processor.executeHeadQueue(db);
    }

    async function setBaseline(block: number | null): Promise<void> {
        await client.query(
            'INSERT INTO simpleassets_config (contract, version, bootstrap_baseline_block) VALUES ($1, $2, $3) ' +
            'ON CONFLICT (contract) DO UPDATE SET bootstrap_baseline_block = EXCLUDED.bootstrap_baseline_block',
            [CONTRACT, '1.0.0', block]
        );
    }

    async function setTotal(group: string, total: number, author = GPK): Promise<void> {
        await client.query(
            'INSERT INTO simpleassets_card_totals (contract, author, mint_group, total_ever) VALUES ($1, $2, $3, $4)',
            [CONTRACT, author, group, total]
        );
    }

    async function getTotal(group: string, author = GPK): Promise<number | null> {
        const result = await client.query(
            'SELECT total_ever FROM simpleassets_card_totals WHERE contract = $1 AND author = $2 AND mint_group = $3',
            [CONTRACT, author, group]
        );

        return result.rowCount === 0 ? null : Number(result.rows[0].total_ever);
    }

    async function getAsset(assetId: string): Promise<Record<string, any> | null> {
        const result = await client.query(
            'SELECT * FROM simpleassets_assets WHERE contract = $1 AND asset_id = $2',
            [CONTRACT, assetId]
        );

        return result.rows[0] ?? null;
    }

    async function getMint(assetId: string): Promise<number | null> {
        const asset = await getAsset(assetId);

        return asset.mint_number === null ? null : Number(asset.mint_number);
    }

    async function seedAsset(assetId: string, values: Record<string, any> = {}): Promise<void> {
        const row: Record<string, any> = {
            contract: CONTRACT, asset_id: assetId, author: GPK, category: 'series1', owner: 'alice',
            mutable_data: '{}', immutable_data: '{}',
            transferred_at_block: 0, transferred_at_time: 0,
            updated_at_block: 0, updated_at_time: 0,
            minted_at_block: 0, minted_at_time: 0,
            ...values,
        };
        const keys = Object.keys(row);

        await client.query(
            'INSERT INTO simpleassets_assets (' + keys.join(', ') + ') VALUES (' + keys.map((_, i) => '$' + (i + 1)).join(', ') + ')',
            keys.map(key => row[key])
        );
    }

    const GROUP_A = JSON.stringify(['series1', '1', 'common', 'base']);
    const GROUP_B = JSON.stringify(['series1', '2', 'rare', 'base']);

    describe('createlog numbering', () => {
        it('numbers each card group from its own total_ever and advances it', async () => {
            await setTotal(GROUP_A, 10);
            await setTotal(GROUP_B, 5);

            await runBatch([
                createlog(2000, '100'),
                createlog(2000, '101', { mdata: { cardid: '2', quality: 'rare', variant: 'base' } }),
            ]);

            expect(await getMint('100')).to.equal(11);
            expect(await getMint('101')).to.equal(6);
            expect((await getAsset('100')).mint_group).to.equal(GROUP_A);
            expect((await getAsset('101')).mint_group).to.equal(GROUP_B);
            expect(await getTotal(GROUP_A)).to.equal(11);
            expect(await getTotal(GROUP_B)).to.equal(6);
        });

        it('builds the group key from category and each configured field, missing fields as empty strings', async () => {
            await runBatch([createlog(2000, '100', { category: 'exotic', mdata: { cardid: 7 } })]);

            expect((await getAsset('100')).mint_group).to.equal('["exotic","7","",""]');
        });

        it('keeps field values that contain spaces in separate groups', async () => {
            await runBatch([
                createlog(2000, '100', { mdata: { cardid: '1', quality: 'common base', variant: '' } }),
                createlog(2000, '101', { mdata: { cardid: '1 common', quality: 'base', variant: '' } }),
            ]);

            expect(await getMint('100')).to.equal(1);
            expect(await getMint('101')).to.equal(1);
            expect(await getTotal(JSON.stringify(['series1', '1', 'common base', '']))).to.equal(1);
            expect(await getTotal(JSON.stringify(['series1', '1 common', 'base', '']))).to.equal(1);
        });

        it('assigns consecutive ordinals in asset id order to creates in one block', async () => {
            await setTotal(GROUP_A, 10);

            // Both ids round to the same double, so only a BigInt compare orders them.
            await runBatch([
                createlog(2000, '100000000000000002'),
                createlog(2000, '100000000000000001'),
            ]);

            expect(await getMint('100000000000000001')).to.equal(11);
            expect(await getMint('100000000000000002')).to.equal(12);
            expect(await getTotal(GROUP_A)).to.equal(12);
        });

        it('numbers block by block when one batch spans several blocks', async () => {
            await setTotal(GROUP_A, 10);

            await runBatch([createlog(2001, '300'), createlog(2002, '250')]);

            expect(await getMint('300')).to.equal(11);
            expect(await getMint('250')).to.equal(12);
        });

        it('assigns no number at or below the bootstrap baseline block and leaves total_ever alone', async () => {
            await setTotal(GROUP_A, 10);

            await runBatch([createlog(999, '100'), createlog(1000, '101'), createlog(1001, '102')]);

            expect(await getMint('100')).to.equal(null);
            expect(await getMint('101')).to.equal(null);
            expect(await getMint('102')).to.equal(11);
            expect(await getTotal(GROUP_A)).to.equal(11);
        });

        it('assigns no number while the contract has no bootstrap baseline block', async () => {
            await setBaseline(null);
            await setTotal(GROUP_A, 10);

            await runBatch([createlog(2000, '100')]);

            expect(await getAsset('100')).to.not.equal(null);
            expect(await getMint('100')).to.equal(null);
            expect(await getTotal(GROUP_A)).to.equal(10);
        });

        it('is idempotent when the same creates replay', async () => {
            await setTotal(GROUP_A, 10);

            await runBatch([createlog(2000, '100'), createlog(2000, '101')]);
            await runBatch([createlog(2000, '100'), createlog(2000, '101')]);

            expect(await getMint('100')).to.equal(11);
            expect(await getMint('101')).to.equal(12);
            expect(await getTotal(GROUP_A)).to.equal(12);
        });

        it('never reuses the ordinal of a burned asset', async () => {
            await setTotal(GROUP_A, 10);

            await runBatch([createlog(2000, '100')]);
            await runBatch([{ block: blockAt(2001), name: 'burnlog', data: { owner: 'alice', assetids: ['100'], memo: '' } }]);
            await runBatch([createlog(2002, '101')]);

            expect((await getAsset('100')).owner).to.equal(null);
            expect(await getMint('100')).to.equal(11);
            expect(await getMint('101')).to.equal(12);
            expect(await getTotal(GROUP_A)).to.equal(12);
        });

        it('starts a group with no totals row at 1 and warns', async () => {
            const warn = sinon.stub(logger, 'warn');

            await runBatch([createlog(2000, '100'), createlog(2000, '101')]);

            expect(await getMint('100')).to.equal(1);
            expect(await getMint('101')).to.equal(2);
            expect(await getTotal(GROUP_A)).to.equal(2);
            expect(warn.calledWithMatch(sinon.match(/no card totals row/))).to.equal(true);
        });

        it('stores a create by an author outside numbered_authors with no number', async () => {
            await setTotal(GROUP_A, 10, 'otherauthor');

            await runBatch([createlog(2000, '100', { author: 'otherauthor' })]);

            const asset = await getAsset('100');
            expect(asset).to.not.equal(null);
            expect(asset.author).to.equal('otherauthor');
            expect(asset.mint_number).to.equal(null);
            expect(asset.mint_group).to.equal(null);
            expect(await getTotal(GROUP_A, 'otherauthor')).to.equal(10);
        });
    });

    describe('block guards', () => {
        beforeEach(async () => {
            await seedAsset('100', { owner: 'alice', updated_at_block: 5000 });
        });

        it('transfer skips a trace older than the stored update block and applies one in the same block', async () => {
            await runBatch([{ block: blockAt(4999), name: 'transfer', data: { from: 'alice', to: 'bob', assetids: ['100'], memo: '' } }]);
            expect((await getAsset('100')).owner).to.equal('alice');

            await runBatch([
                { block: blockAt(5000), name: 'transfer', data: { from: 'alice', to: 'bob', assetids: ['100'], memo: '' } },
                { block: blockAt(5000), name: 'transfer', data: { from: 'bob', to: 'carol', assetids: ['100'], memo: '' } },
            ]);
            expect((await getAsset('100')).owner).to.equal('carol');
        });

        it('burnlog skips a trace older than the stored update block', async () => {
            await runBatch([{ block: blockAt(4999), name: 'burnlog', data: { owner: 'alice', assetids: ['100'], memo: '' } }]);
            expect((await getAsset('100')).burned_by_account).to.equal(null);

            await runBatch([{ block: blockAt(5000), name: 'burnlog', data: { owner: 'alice', assetids: ['100'], memo: '' } }]);
            const asset = await getAsset('100');
            expect(asset.owner).to.equal(null);
            expect(asset.burned_by_account).to.equal('alice');
        });

        it('update skips a trace older than the stored update block', async () => {
            await runBatch([{ block: blockAt(4999), name: 'update', data: { author: GPK, owner: 'alice', assetid: '100', mdata: '{"cardid":"9"}' } }]);
            expect((await getAsset('100')).mutable_data).to.deep.equal({});

            await runBatch([{ block: blockAt(5001), name: 'update', data: { author: GPK, owner: 'alice', assetid: '100', mdata: '{"cardid":"9"}' } }]);
            const asset = await getAsset('100');
            expect(asset.mutable_data).to.deep.equal({ cardid: '9' });
            expect(Number(asset.updated_at_block)).to.equal(5001);
        });

        it('changeauthor skips a trace older than the stored update block', async () => {
            const data = { author: GPK, newauthor: 'newauthor', owner: 'alice', assetids: ['100'], memo: '' };

            await runBatch([{ block: blockAt(4999), name: 'changeauthor', data }]);
            expect((await getAsset('100')).author).to.equal(GPK);

            await runBatch([{ block: blockAt(5000), name: 'changeauthor', data }]);
            expect((await getAsset('100')).author).to.equal('newauthor');
        });

        it('claim skips a trace older than the stored update block', async () => {
            await runBatch([{ block: blockAt(4999), name: 'claim', data: { claimer: 'bob', assetids: ['100'] } }]);
            expect((await getAsset('100')).owner).to.equal('alice');

            await runBatch([{ block: blockAt(5000), name: 'claim', data: { claimer: 'bob', assetids: ['100'] } }]);
            expect((await getAsset('100')).owner).to.equal('bob');
        });

        it('a live trace updates a seed row stored at block 0', async () => {
            await seedAsset('200', { owner: 'alice', updated_at_block: 0, mint_number: 42, mint_group: GROUP_A });

            await runBatch([{ block: blockAt(1), name: 'transfer', data: { from: 'alice', to: 'bob', assetids: ['200'], memo: '' } }]);

            const asset = await getAsset('200');
            expect(asset.owner).to.equal('bob');
            expect(Number(asset.updated_at_block)).to.equal(1);
            expect(Number(asset.mint_number)).to.equal(42);
        });
    });

    describe('claim transfer record', () => {
        it('records the previous owner as the sender when store_transfers is on', async () => {
            register({ store_transfers: true });
            await seedAsset('300', { owner: 'alice' });

            await runBatch([{ block: blockAt(6000), name: 'claim', data: { claimer: 'bob', assetids: ['300'] } }]);

            const transfers = await client.query(
                'SELECT sender, recipient FROM simpleassets_transfers WHERE contract = $1', [CONTRACT]
            );
            expect(transfers.rows).to.deep.equal([{ sender: 'alice', recipient: 'bob' }]);
            expect((await getAsset('300')).owner).to.equal('bob');
        });

        it('records the owner of the lowest asset id as the sender of a multi-offerer claim', async () => {
            register({ store_transfers: true });
            // Stored out of id order, so heap order and id order disagree.
            await seedAsset('401', { owner: 'alice' });
            await seedAsset('400', { owner: 'carol' });

            await runBatch([{ block: blockAt(6000), name: 'claim', data: { claimer: 'bob', assetids: ['401', '400'] } }]);

            const transfers = await client.query(
                'SELECT sender FROM simpleassets_transfers WHERE contract = $1', [CONTRACT]
            );
            expect(transfers.rows).to.deep.equal([{ sender: 'carol' }]);
        });

        it('keeps the recorded sender when the same claim replays', async () => {
            register({ store_transfers: true });
            await seedAsset('500', { owner: 'alice' });
            const block = blockAt(6000);
            const trace = createActionTrace(CONTRACT, 'claim', { claimer: 'bob', assetids: ['500'] });

            for (let pass = 0; pass < 2; pass++) {
                processor.processActionTrace(block, createTx(), trace);
                await processor.executeHeadQueue(db);
            }

            const transfers = await client.query(
                'SELECT sender, recipient FROM simpleassets_transfers WHERE contract = $1', [CONTRACT]
            );
            expect(transfers.rows).to.deep.equal([{ sender: 'alice', recipient: 'bob' }]);
        });
    });

    describe('catch-up write buffer', () => {
        it('gives consecutive ordinals across two create flushes in one transaction', async () => {
            await setTotal(GROUP_A, 10);
            db.enableWriteBuffer();

            await runBatch([createlog(2000, '100')]);
            await runBatch([createlog(2001, '101')]);
            // A read through the transaction flushes both buffers.
            await db.query('SELECT 1');

            expect(await getMint('100')).to.equal(11);
            expect(await getMint('101')).to.equal(12);
            expect(await getTotal(GROUP_A)).to.equal(12);
        });
    });

    describe('fork rollback', () => {
        const READER = 'sa-fork-test';

        it('removes the created rows and restores total_ever', async () => {
            await setTotal(GROUP_A, 10);

            try {
                // A head-mode transaction, so every write records its rollback query.
                db = createTestTransaction(client, READER, 3000);
                await runBatch([
                    createlog(3000, '100'),
                    createlog(3000, '101'),
                    createlog(3000, '102', { mdata: { cardid: '2', quality: 'rare', variant: 'base' } }),
                ]);

                expect(await getMint('101')).to.equal(12);
                expect(await getTotal(GROUP_A)).to.equal(12);
                expect(await getTotal(GROUP_B)).to.equal(1);

                await db.rollbackReversibleBlocks(3000);

                expect(await getAsset('100')).to.equal(null);
                expect(await getAsset('101')).to.equal(null);
                expect(await getAsset('102')).to.equal(null);
                expect(await getTotal(GROUP_A)).to.equal(10);
                expect(await getTotal(GROUP_B)).to.equal(null);
            } finally {
                // The rollback commits its chunks, so the rows this test wrote are
                // durable and the afterEach ROLLBACK cannot reach them.
                await client.query('COMMIT');
                for (const table of ['simpleassets_assets', 'simpleassets_card_totals', 'simpleassets_config']) {
                    await client.query('DELETE FROM ' + table + ' WHERE contract = $1', [CONTRACT]);
                }
                await client.query('DELETE FROM reversible_queries WHERE reader = $1', [READER]);
                await client.query('DELETE FROM reversible_blocks WHERE reader = $1', [READER]);
                await client.query('BEGIN');
            }
        });
    });

    describe('deleteDB', () => {
        it('deletes the contract card totals and leaves another contract untouched', async () => {
            await setTotal(GROUP_A, 10);
            await client.query(
                'INSERT INTO simpleassets_card_totals (contract, author, mint_group, total_ever) VALUES ($1, $2, $3, $4)',
                ['othercontrct', GPK, GROUP_A, 3]
            );

            await SimpleAssetsHandler.prototype.deleteDB.call(
                { args: { simpleassets_account: CONTRACT } },
                { query: client.query.bind(client), escapeIdentifier: (s: string) => client.escapeIdentifier(s) }
            );

            expect(await getTotal(GROUP_A)).to.equal(null);
            const other = await client.query('SELECT total_ever FROM simpleassets_card_totals WHERE contract = $1', ['othercontrct']);
            expect(other.rowCount).to.equal(1);
        });
    });
});
