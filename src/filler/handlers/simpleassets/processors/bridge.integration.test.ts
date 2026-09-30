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
import { bridgeProcessor } from './bridge';
import SimpleAssetsHandler from '../index';
import DataProcessor, { ProcessingState } from '../../../processor';
import { ContractDBTransaction } from '../../../database';
import { ModuleLoader } from '../../../modules';
import { EosioActionTrace } from '../../../../types/eosio';
import logger from '../../../../utils/winston';

const CONTRACT = 'simpleassets';
const AA_CONTRACT = 'atomicassets';
const BRIDGE = 'atomicbridge';
const GPK = 'gpk.topps';
const GROUP_A = JSON.stringify(['series1', '1', 'common', 'base']);

function createMockCore(overrides: Record<string, any> = {}): any {
    return {
        args: {
            simpleassets_account: CONTRACT,
            atomicassets_account: AA_CONTRACT,
            bridge_account: BRIDGE,
            store_transfers: false,
            numbered_authors: [GPK],
            numbered_group_fields: ['cardid', 'quality', 'variant'],
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

// The attribute map form a logmint trace carries after ABI deserialization.
function logmintTrace(assetId: string, overrides: Record<string, any> = {}): EosioActionTrace<any> {
    const immutable = 'sassets_id' in overrides
        ? (overrides.sassets_id === undefined ? [] : [{ key: 'sassets_id', value: ['uint64', overrides.sassets_id] }])
        : [{ key: 'sassets_id', value: ['uint64', '100'] }];

    return createActionTrace(AA_CONTRACT, 'logmint', {
        asset_id: assetId,
        authorized_minter: overrides.minter ?? BRIDGE,
        collection_name: GPK,
        schema_name: 'series1',
        template_id: -1,
        new_asset_owner: 'alice',
        immutable_data: [{ key: 'cardid', value: ['uint16', 1] }, ...immutable],
        mutable_data: [],
        backed_tokens: [],
        immutable_template_data: [],
    });
}

function createlogTrace(assetId: string): EosioActionTrace<any> {
    return createActionTrace(CONTRACT, 'createlog', {
        author: GPK,
        category: 'series1',
        owner: 'alice',
        idata: '{}',
        mdata: JSON.stringify({ cardid: 1, quality: 'common', variant: 'base' }),
        assetid: assetId,
        requireclaim: false,
    });
}

describe('simpleassets bridgeProcessor', () => {
    let client: Client;
    let processor: DataProcessor;
    let db: ContractDBTransaction;
    let destructors: Array<() => any> = [];

    before(async () => {
        const ctx = createProcessorTestContext();
        client = ctx.client;
        await client.connect();
    });

    after(async () => {
        await client.end();
    });

    function register(coreOverrides: Record<string, any> = {}): void {
        destructors.forEach(fn => fn());
        processor = new DataProcessor(ProcessingState.HEAD, createMockModuleLoader());
        const core = createMockCore(coreOverrides);
        destructors = [assetProcessor(core, processor), bridgeProcessor(core, processor)];
    }

    beforeEach(async () => {
        await client.query('BEGIN');
        db = createTestTransaction(client);
        register();
        await client.query(
            'INSERT INTO simpleassets_config (contract, version, bootstrap_baseline_block) VALUES ($1, $2, $3)',
            [CONTRACT, '1.0.0', 1000]
        );
    });

    afterEach(async () => {
        sinon.restore();
        destructors.forEach(fn => fn());
        destructors = [];
        await client.query('ROLLBACK');
    });

    async function run(blockNum: number, traces: EosioActionTrace<any>[]): Promise<void> {
        const block = createBlock({ block_num: blockNum });

        for (const trace of traces) {
            processor.processActionTrace(block, createTx(), trace);
        }

        await processor.executeHeadQueue(db);
    }

    async function seedAsset(assetId: string, mintNumber: number | null): Promise<void> {
        await client.query(
            'INSERT INTO simpleassets_assets (contract, asset_id, author, category, owner, mint_number, ' +
            'transferred_at_block, transferred_at_time, updated_at_block, updated_at_time, minted_at_block, minted_at_time) ' +
            'VALUES ($1, $2, $3, $4, $5, $6, 0, 0, 0, 0, 0, 0)',
            [CONTRACT, assetId, GPK, 'series1', 'alice', mintNumber]
        );
    }

    async function getLink(assetId: string): Promise<Record<string, any> | null> {
        const result = await client.query(
            'SELECT * FROM atomicassets_original_mints WHERE contract = $1 AND asset_id = $2',
            [AA_CONTRACT, assetId]
        );

        return result.rows[0] ?? null;
    }

    async function countLinks(): Promise<number> {
        const result = await client.query(
            'SELECT count(*)::int AS n FROM atomicassets_original_mints WHERE contract = $1', [AA_CONTRACT]
        );

        return result.rows[0].n;
    }

    it('links a bridge mint to the SimpleAssets asset and copies its mint', async () => {
        await seedAsset('100', 7);

        await run(2000, [logmintTrace('1099511627776')]);

        const link = await getLink('1099511627776');
        expect(link).to.not.equal(null);
        expect(link.original_contract).to.equal(CONTRACT);
        expect(link.original_asset_id).to.equal('100');
        expect(link.original_mint).to.equal('7');
        expect(link.block_num).to.equal('2000');
    });

    it('creates no link for a mint by another minter', async () => {
        await seedAsset('100', 7);

        await run(2000, [logmintTrace('1099511627776', { minter: 'gpkcrashpack' })]);

        expect(await countLinks()).to.equal(0);
    });

    it('creates no link for a bridge mint without sassets_id', async () => {
        await seedAsset('100', 7);

        await run(2000, [logmintTrace('1099511627776', { sassets_id: undefined })]);

        expect(await countLinks()).to.equal(0);
    });

    it('stores a null mint and warns when the SimpleAssets asset has no mint', async () => {
        const warn = sinon.stub(logger, 'warn');
        await seedAsset('100', null);

        await run(2000, [logmintTrace('1099511627776')]);

        const link = await getLink('1099511627776');
        expect(link.original_asset_id).to.equal('100');
        expect(link.original_mint).to.equal(null);
        expect(warn.calledWithMatch(sinon.match(/no mint/))).to.equal(true);
    });

    it('stores a null mint and warns when the SimpleAssets asset is not stored', async () => {
        const warn = sinon.stub(logger, 'warn');

        await run(2000, [logmintTrace('1099511627776')]);

        expect((await getLink('1099511627776')).original_mint).to.equal(null);
        expect(warn.calledWithMatch(sinon.match(/no mint/))).to.equal(true);
    });

    it('links to the number a create in the same batch assigns', async () => {
        await client.query(
            'INSERT INTO simpleassets_card_totals (contract, author, mint_group, total_ever) VALUES ($1, $2, $3, $4)',
            [CONTRACT, GPK, GROUP_A, 10]
        );

        // The logmint is queued first, so only the priority order puts the create ahead of it.
        await run(2000, [logmintTrace('1099511627776'), createlogTrace('100')]);

        expect((await getLink('1099511627776')).original_mint).to.equal('11');
    });

    it('keeps one unchanged link when the same logmint replays', async () => {
        await seedAsset('100', 7);
        const trace = logmintTrace('1099511627776');

        await run(2000, [trace]);
        await client.query('UPDATE simpleassets_assets SET mint_number = 8 WHERE contract = $1 AND asset_id = 100', [CONTRACT]);
        await run(2000, [trace]);

        expect(await countLinks()).to.equal(1);
        expect((await getLink('1099511627776')).original_mint).to.equal('7');
    });

    it('registers no listener without bridge_account', () => {
        register({ bridge_account: undefined, atomicassets_account: undefined });

        expect(processor.actionTraceNeeded(AA_CONTRACT, 'logmint').process).to.equal(false);
    });

    it('decodes the attribute map, so it deserializes the logmint action', () => {
        expect(processor.actionTraceNeeded(AA_CONTRACT, 'logmint')).to.deep.equal({ process: true, deserialize: true });
    });

    describe('fork rollback', () => {
        const READER = 'sa-bridge-fork-test';

        it('removes the link its reader wrote', async () => {
            await seedAsset('100', 7);

            try {
                db = createTestTransaction(client, READER, 3000);
                await run(3000, [logmintTrace('1099511627776')]);
                expect(await countLinks()).to.equal(1);

                await db.rollbackReversibleBlocks(3000);

                expect(await countLinks()).to.equal(0);
            } finally {
                // The rollback commits its chunks, so the afterEach ROLLBACK cannot reach these rows.
                await client.query('COMMIT');
                await client.query('DELETE FROM atomicassets_original_mints WHERE contract = $1', [AA_CONTRACT]);
                for (const table of ['simpleassets_assets', 'simpleassets_config']) {
                    await client.query('DELETE FROM ' + table + ' WHERE contract = $1', [CONTRACT]);
                }
                await client.query('DELETE FROM reversible_queries WHERE reader = $1', [READER]);
                await client.query('DELETE FROM reversible_blocks WHERE reader = $1', [READER]);
                await client.query('BEGIN');
            }
        });
    });

    describe('deleteDB', () => {
        it('deletes the links of its contract and leaves another source untouched', async () => {
            await seedAsset('100', 7);
            await run(2000, [logmintTrace('1099511627776')]);
            await client.query(
                'INSERT INTO atomicassets_original_mints (contract, asset_id, original_contract, original_asset_id, original_mint, block_num) ' +
                'VALUES ($1, $2, $3, $4, $5, $6)',
                [AA_CONTRACT, '1099511627777', 'othersource', '5', 1, 2000]
            );

            await SimpleAssetsHandler.prototype.deleteDB.call(
                { args: { simpleassets_account: CONTRACT } },
                { query: client.query.bind(client), escapeIdentifier: (s: string) => client.escapeIdentifier(s) }
            );

            expect(await getLink('1099511627776')).to.equal(null);
            expect(await getLink('1099511627777')).to.not.equal(null);
        });
    });
});
