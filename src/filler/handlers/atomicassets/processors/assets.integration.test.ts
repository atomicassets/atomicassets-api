import 'mocha';
import { expect } from 'chai';
import { Client } from 'pg';
import {
    createProcessorTestContext,
    createMockNotifier,
    createBlock,
    createTx,
    createActionTrace,
    processActionTrace,
    createTestTransaction,
} from '../../test-helper';
import { assetProcessor } from './assets';
import DataProcessor, { ProcessingState } from '../../../processor';
import { ContractDBTransaction } from '../../../database';
import {
    LogMintAssetActionData,
    LogBurnAssetActionData,
    LogSetDataActionData,
    LogTransferActionData,
    LogBackAssetActionData,
} from '../types/actions';
import { ModuleLoader } from '../../../modules';
import { eosioTimestampToDate } from '../../../../utils/eosio';

const CONTRACT = 'atomicassets';

function createMockCore(overrides: Record<string, any> = {}): any {
    return {
        args: {
            atomicassets_account: CONTRACT,
            store_transfers: true,
            store_logs: false,
            ...overrides,
        },
        config: {
            collection_format: [],
            supported_tokens: [],
            asset_counter: 0,
            offer_counter: 0,
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

describe('assetProcessor', () => {
    let client: Client;
    let processor: DataProcessor;
    let db: ContractDBTransaction;
    let destroyProcessor: () => any;

    before(async () => {
        const ctx = createProcessorTestContext();
        client = ctx.client;
        await client.connect();
    });

    after(async () => {
        await client.end();
    });

    beforeEach(async () => {
        await client.query('BEGIN');
        processor = new DataProcessor(ProcessingState.HEAD, createMockModuleLoader());
        db = createTestTransaction(client);
        const core = createMockCore();
        const notifier = createMockNotifier();
        destroyProcessor = assetProcessor(core as any, processor, notifier);
    });

    afterEach(async () => {
        if (destroyProcessor) {
            destroyProcessor();
        }
        await client.query('ROLLBACK');
    });

    describe('logmint', () => {
        it('should insert a new asset and mint record', async () => {
            const block = createBlock();
            const tx = createTx();
            const data: LogMintAssetActionData = {
                asset_id: '1099511627776',
                authorized_minter: 'minter1',
                collection_name: 'testcol11111',
                schema_name: 'testschema11',
                template_id: 1,
                new_asset_owner: 'owner1111111',
                immutable_data: [],
                mutable_data: [],
                backed_tokens: [],
                immutable_template_data: [],
            };
            const trace = createActionTrace(CONTRACT, 'logmint', data);

            await processActionTrace(processor, db, block, tx, trace);

            const assetResult = await client.query(
                'SELECT * FROM atomicassets_assets WHERE contract = $1 AND asset_id = $2',
                [CONTRACT, data.asset_id]
            );
            expect(assetResult.rowCount).to.equal(1);
            const asset = assetResult.rows[0];
            expect(asset.collection_name).to.equal('testcol11111');
            expect(asset.schema_name).to.equal('testschema11');
            expect(asset.template_id).to.equal('1');
            expect(asset.owner).to.equal('owner1111111');
            expect(asset.mutable_data).to.deep.equal({});
            expect(asset.immutable_data).to.deep.equal({});
            expect(asset.burned_by_account).to.be.null;
            expect(asset.burned_at_block).to.be.null;
            expect(Number(asset.minted_at_block)).to.equal(block.block_num);

            const mintResult = await client.query(
                'SELECT * FROM atomicassets_mints WHERE contract = $1 AND asset_id = $2',
                [CONTRACT, data.asset_id]
            );
            expect(mintResult.rowCount).to.equal(1);
            const mint = mintResult.rows[0];
            expect(mint.receiver).to.equal('owner1111111');
            expect(mint.minter).to.equal('minter1');
        });

        it('should tolerate replaying a mint whose row already exists', async () => {
            const block = createBlock();
            const tx = createTx();
            const data: LogMintAssetActionData = {
                asset_id: '1099511627777',
                authorized_minter: 'minter1',
                collection_name: 'testcol11111',
                schema_name: 'testschema11',
                template_id: 1,
                new_asset_owner: 'owner1111111',
                immutable_data: [],
                mutable_data: [],
                backed_tokens: [],
                immutable_template_data: [],
            };
            const trace = createActionTrace(CONTRACT, 'logmint', data);

            await processActionTrace(processor, db, block, tx, trace);
            await processActionTrace(processor, db, block, tx, trace);

            const mintResult = await client.query(
                'SELECT * FROM atomicassets_mints WHERE contract = $1 AND asset_id = $2',
                [CONTRACT, data.asset_id]
            );
            expect(mintResult.rowCount).to.equal(1);
        });

        it('should set template_id to null when template_id is -1', async () => {
            const block = createBlock();
            const tx = createTx();
            const data: LogMintAssetActionData = {
                asset_id: '1099511627777',
                authorized_minter: 'minter1',
                collection_name: 'testcol11111',
                schema_name: 'testschema11',
                template_id: -1,
                new_asset_owner: 'owner1111111',
                immutable_data: [],
                mutable_data: [],
                backed_tokens: [],
                immutable_template_data: [],
            };
            const trace = createActionTrace(CONTRACT, 'logmint', data);

            await processActionTrace(processor, db, block, tx, trace);

            const result = await client.query(
                'SELECT template_id FROM atomicassets_assets WHERE contract = $1 AND asset_id = $2',
                [CONTRACT, data.asset_id]
            );
            expect(result.rows[0].template_id).to.be.null;
        });

        it('should store mutable and immutable data from attribute maps', async () => {
            const block = createBlock();
            const tx = createTx();
            const data: LogMintAssetActionData = {
                asset_id: '1099511627778',
                authorized_minter: 'minter1',
                collection_name: 'testcol11111',
                schema_name: 'testschema11',
                template_id: 2,
                new_asset_owner: 'owner1111111',
                immutable_data: [
                    { key: 'name', value: ['string', 'Test NFT'] },
                ],
                mutable_data: [
                    { key: 'level', value: ['uint64', 5] },
                ],
                backed_tokens: [],
                immutable_template_data: [],
            };
            const trace = createActionTrace(CONTRACT, 'logmint', data);

            await processActionTrace(processor, db, block, tx, trace);

            const result = await client.query(
                'SELECT mutable_data, immutable_data FROM atomicassets_assets WHERE contract = $1 AND asset_id = $2',
                [CONTRACT, data.asset_id]
            );
            const row = result.rows[0];
            expect((typeof row.immutable_data === 'string' ? JSON.parse(row.immutable_data) : row.immutable_data)).to.deep.equal({ name: 'Test NFT' });
            expect((typeof row.mutable_data === 'string' ? JSON.parse(row.mutable_data) : row.mutable_data)).to.deep.equal({ level: '5' });
        });

        it('should store a float32 attribute as a jsonb number', async () => {
            const block = createBlock();
            const tx = createTx();
            const data: LogMintAssetActionData = {
                asset_id: '1099511627779',
                authorized_minter: 'minter1',
                collection_name: 'testcol11111',
                schema_name: 'testschema11',
                template_id: 2,
                new_asset_owner: 'owner1111111',
                immutable_data: [
                    // The 1.x decoder's wharfkit objectify rendered a Float32 wrapper through
                    // toFixed(7), so the payload carried this fixed-precision string, not a number.
                    { key: 'wear', value: ['float32', '0.7500000'] },
                ],
                mutable_data: [],
                backed_tokens: [],
                immutable_template_data: [],
            };
            const trace = createActionTrace(CONTRACT, 'logmint', data);

            await processActionTrace(processor, db, block, tx, trace);

            const result = await client.query(
                'SELECT immutable_data, jsonb_typeof(immutable_data -> \'wear\') AS wear_type ' +
                'FROM atomicassets_assets WHERE contract = $1 AND asset_id = $2',
                [CONTRACT, data.asset_id]
            );
            const row = result.rows[0];
            expect((typeof row.immutable_data === 'string' ? JSON.parse(row.immutable_data) : row.immutable_data)).to.deep.equal({ wear: 0.75 });
            // The shape an asset serves has to match what the byte decoder
            // writes for the same attribute on a template, which is a number.
            expect(row.wear_type).to.equal('number');
        });

        it('should store a non-finite float attribute as jsonb null', async () => {
            const block = createBlock();
            const tx = createTx();
            const data: LogMintAssetActionData = {
                asset_id: '1099511627780',
                authorized_minter: 'minter1',
                collection_name: 'testcol11111',
                schema_name: 'testschema11',
                template_id: 3,
                new_asset_owner: 'owner1111111',
                immutable_data: [
                    // A numeric decoder yields the IEEE value, and a non-finite one
                    // has no JSON number. encodeDatabaseJson is JSON.stringify, which
                    // writes null for both, so this is the shape the column receives.
                    { key: 'wear', value: ['float32', NaN] },
                    { key: 'score', value: ['float64', Infinity] },
                ],
                mutable_data: [],
                backed_tokens: [],
                immutable_template_data: [],
            };
            const trace = createActionTrace(CONTRACT, 'logmint', data);

            await processActionTrace(processor, db, block, tx, trace);

            const result = await client.query(
                'SELECT immutable_data, jsonb_typeof(immutable_data -> \'wear\') AS wear_type, ' +
                'jsonb_typeof(immutable_data -> \'score\') AS score_type ' +
                'FROM atomicassets_assets WHERE contract = $1 AND asset_id = $2',
                [CONTRACT, data.asset_id]
            );
            const row = result.rows[0];
            expect((typeof row.immutable_data === 'string' ? JSON.parse(row.immutable_data) : row.immutable_data))
                .to.deep.equal({ wear: null, score: null });
            // JSON null under the key, not a dropped key, which is what the
            // repair rewrites the strings an earlier decoder stored to.
            expect(row.wear_type).to.equal('null');
            expect(row.score_type).to.equal('null');
        });
    });

    describe('logburnasset', () => {
        it('should mark an asset as burned', async () => {
            // First mint an asset
            const mintBlock = createBlock();
            const mintTx = createTx();
            const mintData: LogMintAssetActionData = {
                asset_id: '2000000000001',
                authorized_minter: 'minter1',
                collection_name: 'testcol11111',
                schema_name: 'testschema11',
                template_id: 1,
                new_asset_owner: 'owner1111111',
                immutable_data: [],
                mutable_data: [],
                backed_tokens: [],
                immutable_template_data: [],
            };
            const mintTrace = createActionTrace(CONTRACT, 'logmint', mintData);
            await processActionTrace(processor, db, mintBlock, mintTx, mintTrace);

            // Now burn it
            const burnBlock = createBlock({ timestamp: '2023-06-15T12:00:00.000' });
            const burnTx = createTx();
            const burnData: LogBurnAssetActionData = {
                asset_owner: 'owner1111111',
                asset_id: '2000000000001',
                collection_name: 'testcol11111',
                schema_name: 'testschema11',
                template_id: 1,
                backed_tokens: [],
                asset_ram_payer: 'minter1',
                old_immutable_data: [],
                old_mutable_data: [],
            };
            const burnTrace = createActionTrace(CONTRACT, 'logburnasset', burnData);
            await processActionTrace(processor, db, burnBlock, burnTx, burnTrace);

            const result = await client.query(
                'SELECT * FROM atomicassets_assets WHERE contract = $1 AND asset_id = $2',
                [CONTRACT, '2000000000001']
            );
            expect(result.rowCount).to.equal(1);
            const asset = result.rows[0];
            expect(asset.owner).to.be.null;
            expect(asset.burned_by_account).to.equal('owner1111111');
            expect(Number(asset.burned_at_block)).to.equal(burnBlock.block_num);
            expect(Number(asset.burned_at_time)).to.equal(
                eosioTimestampToDate(burnBlock.timestamp).getTime()
            );
        });
    });

    describe('logsetdata', () => {
        it('should update mutable data on an asset', async () => {
            // Mint first
            const mintBlock = createBlock();
            const mintTx = createTx();
            const mintData: LogMintAssetActionData = {
                asset_id: '3000000000001',
                authorized_minter: 'minter1',
                collection_name: 'testcol11111',
                schema_name: 'testschema11',
                template_id: 1,
                new_asset_owner: 'owner1111111',
                immutable_data: [],
                mutable_data: [{ key: 'level', value: ['uint64', 1] }],
                backed_tokens: [],
                immutable_template_data: [],
            };
            const mintTrace = createActionTrace(CONTRACT, 'logmint', mintData);
            await processActionTrace(processor, db, mintBlock, mintTx, mintTrace);

            // Update mutable data
            const updateBlock = createBlock();
            const updateTx = createTx();
            const updateData: LogSetDataActionData = {
                asset_owner: 'owner1111111',
                asset_id: '3000000000001',
                old_data: [{ key: 'level', value: ['uint64', 1] }],
                new_data: [
                    { key: 'level', value: ['uint64', 5] },
                    { key: 'xp', value: ['uint64', 100] },
                ],
            };
            const updateTrace = createActionTrace(CONTRACT, 'logsetdata', updateData);
            await processActionTrace(processor, db, updateBlock, updateTx, updateTrace);

            const result = await client.query(
                'SELECT mutable_data, updated_at_block FROM atomicassets_assets WHERE contract = $1 AND asset_id = $2',
                [CONTRACT, '3000000000001']
            );
            expect(result.rowCount).to.equal(1);
            const row = result.rows[0];
            expect((typeof row.mutable_data === 'string' ? JSON.parse(row.mutable_data) : row.mutable_data)).to.deep.equal({ level: '5', xp: '100' });
            expect(Number(row.updated_at_block)).to.equal(updateBlock.block_num);
        });

        it('should store a float64 attribute as a jsonb number', async () => {
            const mintBlock = createBlock();
            const mintTx = createTx();
            const mintData: LogMintAssetActionData = {
                asset_id: '3000000000002',
                authorized_minter: 'minter1',
                collection_name: 'testcol11111',
                schema_name: 'testschema11',
                template_id: 1,
                new_asset_owner: 'owner1111111',
                immutable_data: [],
                mutable_data: [],
                backed_tokens: [],
                immutable_template_data: [],
            };
            await processActionTrace(processor, db, mintBlock, mintTx, createActionTrace(CONTRACT, 'logmint', mintData));

            const updateBlock = createBlock();
            const updateTx = createTx();
            const updateData: LogSetDataActionData = {
                asset_owner: 'owner1111111',
                asset_id: '3000000000002',
                old_data: [],
                new_data: [
                    { key: 'score', value: ['float64', 92.13924923] },
                ],
            };
            await processActionTrace(processor, db, updateBlock, updateTx, createActionTrace(CONTRACT, 'logsetdata', updateData));

            const result = await client.query(
                'SELECT mutable_data, jsonb_typeof(mutable_data -> \'score\') AS score_type ' +
                'FROM atomicassets_assets WHERE contract = $1 AND asset_id = $2',
                [CONTRACT, '3000000000002']
            );
            const row = result.rows[0];
            expect((typeof row.mutable_data === 'string' ? JSON.parse(row.mutable_data) : row.mutable_data)).to.deep.equal({ score: 92.13924923 });
            expect(row.score_type).to.equal('number');
        });
    });

    describe('logtransfer', () => {
        it('should transfer asset ownership and create transfer records', async () => {
            // Mint
            const mintBlock = createBlock();
            const mintTx = createTx();
            const mintData: LogMintAssetActionData = {
                asset_id: '4000000000001',
                authorized_minter: 'minter1',
                collection_name: 'testcol11111',
                schema_name: 'testschema11',
                template_id: 1,
                new_asset_owner: 'sender111111',
                immutable_data: [],
                mutable_data: [],
                backed_tokens: [],
                immutable_template_data: [],
            };
            const mintTrace = createActionTrace(CONTRACT, 'logmint', mintData);
            await processActionTrace(processor, db, mintBlock, mintTx, mintTrace);

            // Transfer
            const transferBlock = createBlock({ timestamp: '2023-07-01T06:00:00.000' });
            const transferTx = createTx();
            const transferData: LogTransferActionData = {
                collection_name: 'testcol11111',
                from: 'sender111111',
                to: 'receiver1111',
                asset_ids: ['4000000000001'],
                memo: 'test transfer',
            };
            const transferTrace = createActionTrace(CONTRACT, 'logtransfer', transferData);
            await processActionTrace(processor, db, transferBlock, transferTx, transferTrace);

            // Check asset ownership changed
            const assetResult = await client.query(
                'SELECT owner, transferred_at_block FROM atomicassets_assets WHERE contract = $1 AND asset_id = $2',
                [CONTRACT, '4000000000001']
            );
            expect(assetResult.rows[0].owner).to.equal('receiver1111');
            expect(Number(assetResult.rows[0].transferred_at_block)).to.equal(transferBlock.block_num);

            // Check transfer record created (store_transfers = true)
            const transferResult = await client.query(
                'SELECT * FROM atomicassets_transfers WHERE contract = $1 AND transfer_id = $2',
                [CONTRACT, transferTrace.global_sequence]
            );
            expect(transferResult.rowCount).to.equal(1);
            expect(transferResult.rows[0].sender).to.equal('sender111111');
            expect(transferResult.rows[0].recipient).to.equal('receiver1111');
            expect(transferResult.rows[0].memo).to.equal('test transfer');

            // Check transfer assets record
            const transferAssetsResult = await client.query(
                'SELECT * FROM atomicassets_transfers_assets WHERE contract = $1 AND transfer_id = $2',
                [CONTRACT, transferTrace.global_sequence]
            );
            expect(transferAssetsResult.rowCount).to.equal(1);
            expect(transferAssetsResult.rows[0].asset_id).to.equal('4000000000001');
        });

        // Chunking: assets.ts caps each UPDATE at ASSET_CHUNK_SIZE=100 asset_ids and
        // each transfers_assets INSERT at 1000 rows. A single uncapped logtransfer
        // observed 3,000 asset_ids on WAX block #431316736 (2026-04-25), which busts
        // the cluster's 30s statement_timeout. These tests verify the chunk
        // boundaries and end-to-end correctness across chunks.
        describe('chunking', () => {
            function spyOnUpdate(target: ContractDBTransaction): {
                calls: Array<{ table: string; values: any; condition: any }>;
                restore: () => void;
            } {
                const calls: Array<{ table: string; values: any; condition: any }> = [];
                const originalUpdate = target.update.bind(target);
                (target as any).update = async (...args: any[]) => {
                    const [table, values, condition] = args;
                    calls.push({ table, values, condition });
                    return originalUpdate(...args);
                };
                return { calls, restore: () => { (target as any).update = originalUpdate; } };
            }

            function spyOnInsert(target: ContractDBTransaction): {
                calls: Array<{ table: string; rowCount: number }>;
                restore: () => void;
            } {
                const calls: Array<{ table: string; rowCount: number }> = [];
                const originalInsert = target.insert.bind(target);
                (target as any).insert = async (...args: any[]) => {
                    const [table, rows] = args;
                    const rowCount = Array.isArray(rows) ? rows.length : 1;
                    calls.push({ table, rowCount });
                    return originalInsert(...args);
                };
                return { calls, restore: () => { (target as any).insert = originalInsert; } };
            }

            async function mintAssetsWithOwner(owner: string, assetIds: string[]): Promise<void> {
                for (const assetId of assetIds) {
                    const mintTrace = createActionTrace(CONTRACT, 'logmint', {
                        asset_id: assetId,
                        authorized_minter: 'minter1',
                        collection_name: 'testcol11111',
                        schema_name: 'testschema11',
                        template_id: 1,
                        new_asset_owner: owner,
                        immutable_data: [],
                        mutable_data: [],
                        backed_tokens: [],
                        immutable_template_data: [],
                    } as LogMintAssetActionData);
                    await processActionTrace(processor, db, createBlock(), createTx(), mintTrace);
                }
            }

            it('issues a single UPDATE for asset counts at or below CHUNK_SIZE', async () => {
                const assetIds = Array.from({ length: 100 }, (_, i) => String(6_000_000_000 + i));
                await mintAssetsWithOwner('sender111111', assetIds);

                const updateSpy = spyOnUpdate(db);
                try {
                    const transferData: LogTransferActionData = {
                        collection_name: 'testcol11111',
                        from: 'sender111111',
                        to: 'receiver1111',
                        asset_ids: assetIds,
                        memo: 'small transfer',
                    };
                    const transferTrace = createActionTrace(CONTRACT, 'logtransfer', transferData);
                    const transferBlock = createBlock();
                    await processActionTrace(processor, db, transferBlock, createTx(), transferTrace);

                    const assetUpdates = updateSpy.calls.filter(c => c.table === 'atomicassets_assets');
                    expect(assetUpdates).to.have.lengthOf(1);

                    const ownersResult = await client.query(
                        'SELECT DISTINCT owner FROM atomicassets_assets WHERE contract = $1 AND asset_id = ANY($2)',
                        [CONTRACT, assetIds]
                    );
                    expect(ownersResult.rowCount).to.equal(1);
                    expect(ownersResult.rows[0].owner).to.equal('receiver1111');
                } finally {
                    updateSpy.restore();
                }
            });

            it('issues multiple UPDATEs when asset_ids exceed CHUNK_SIZE and updates every row', async () => {
                // 250 unique ids -> ceil(250/100) = 3 UPDATE calls.
                const assetIds = Array.from({ length: 250 }, (_, i) => String(7_000_000_000 + i));
                await mintAssetsWithOwner('sender111111', assetIds);

                const updateSpy = spyOnUpdate(db);
                const insertSpy = spyOnInsert(db);
                try {
                    const transferData: LogTransferActionData = {
                        collection_name: 'testcol11111',
                        from: 'sender111111',
                        to: 'receiver1111',
                        asset_ids: assetIds,
                        memo: 'big transfer',
                    };
                    const transferTrace = createActionTrace(CONTRACT, 'logtransfer', transferData);
                    const transferBlock = createBlock();
                    await processActionTrace(processor, db, transferBlock, createTx(), transferTrace);

                    const assetUpdates = updateSpy.calls.filter(c => c.table === 'atomicassets_assets');
                    expect(assetUpdates).to.have.lengthOf(3);
                    for (const call of assetUpdates) {
                        const idChunk = call.condition.values[1];
                        expect(idChunk.length).to.be.at.most(100);
                    }

                    const ownersResult = await client.query(
                        'SELECT DISTINCT owner FROM atomicassets_assets WHERE contract = $1 AND asset_id = ANY($2)',
                        [CONTRACT, assetIds]
                    );
                    expect(ownersResult.rowCount).to.equal(1);
                    expect(ownersResult.rows[0].owner).to.equal('receiver1111');

                    const transferAssetsResult = await client.query(
                        'SELECT COUNT(*)::int AS n FROM atomicassets_transfers_assets WHERE contract = $1 AND transfer_id = $2',
                        [CONTRACT, transferTrace.global_sequence]
                    );
                    expect(transferAssetsResult.rows[0].n).to.equal(250);

                    // 250 transfers_assets rows fit in a single 1000-row insert chunk.
                    const transferAssetsInserts = insertSpy.calls.filter(c => c.table === 'atomicassets_transfers_assets');
                    expect(transferAssetsInserts).to.have.lengthOf(1);
                    expect(transferAssetsInserts[0].rowCount).to.equal(250);
                } finally {
                    updateSpy.restore();
                    insertSpy.restore();
                }
            });

            it('chunks transfers_assets inserts above 1000 rows', async () => {
                // 1500 unique ids -> 15 UPDATE chunks and 2 INSERT chunks (1000 + 500).
                const assetIds = Array.from({ length: 1500 }, (_, i) => String(8_000_000_000 + i));
                await mintAssetsWithOwner('sender111111', assetIds);

                const insertSpy = spyOnInsert(db);
                try {
                    const transferData: LogTransferActionData = {
                        collection_name: 'testcol11111',
                        from: 'sender111111',
                        to: 'receiver1111',
                        asset_ids: assetIds,
                        memo: 'huge transfer',
                    };
                    const transferTrace = createActionTrace(CONTRACT, 'logtransfer', transferData);
                    await processActionTrace(processor, db, createBlock(), createTx(), transferTrace);

                    const transferAssetsInserts = insertSpy.calls.filter(c => c.table === 'atomicassets_transfers_assets');
                    expect(transferAssetsInserts).to.have.lengthOf(2);
                    expect(transferAssetsInserts[0].rowCount).to.equal(1000);
                    expect(transferAssetsInserts[1].rowCount).to.equal(500);

                    const transferAssetsResult = await client.query(
                        'SELECT COUNT(*)::int AS n FROM atomicassets_transfers_assets WHERE contract = $1 AND transfer_id = $2',
                        [CONTRACT, transferTrace.global_sequence]
                    );
                    expect(transferAssetsResult.rows[0].n).to.equal(1500);
                } finally {
                    insertSpy.restore();
                }
            });

            it('skips chunking and DB work entirely on empty asset_ids', async () => {
                const updateSpy = spyOnUpdate(db);
                try {
                    const transferData: LogTransferActionData = {
                        collection_name: 'testcol11111',
                        from: 'sender111111',
                        to: 'receiver1111',
                        asset_ids: [],
                        memo: 'no-op transfer',
                    };
                    const transferTrace = createActionTrace(CONTRACT, 'logtransfer', transferData);
                    await processActionTrace(processor, db, createBlock(), createTx(), transferTrace);

                    const assetUpdates = updateSpy.calls.filter(c => c.table === 'atomicassets_assets');
                    expect(assetUpdates).to.have.lengthOf(0);
                } finally {
                    updateSpy.restore();
                }
            });
        });

        it('should skip transfer records when store_transfers is false', async () => {
            // Re-create processor with store_transfers = false
            if (destroyProcessor) {
                destroyProcessor();
            }
            processor = new DataProcessor(ProcessingState.HEAD, createMockModuleLoader());
            db = createTestTransaction(client);
            const core = createMockCore({ store_transfers: false });
            destroyProcessor = assetProcessor(core as any, processor, createMockNotifier());

            // Mint
            const mintBlock = createBlock();
            const mintTx = createTx();
            const mintData: LogMintAssetActionData = {
                asset_id: '4000000000002',
                authorized_minter: 'minter1',
                collection_name: 'testcol11111',
                schema_name: 'testschema11',
                template_id: 1,
                new_asset_owner: 'sender111111',
                immutable_data: [],
                mutable_data: [],
                backed_tokens: [],
                immutable_template_data: [],
            };
            const mintTrace = createActionTrace(CONTRACT, 'logmint', mintData);
            await processActionTrace(processor, db, mintBlock, mintTx, mintTrace);

            // Transfer
            const transferBlock = createBlock();
            const transferTx = createTx();
            const transferData: LogTransferActionData = {
                collection_name: 'testcol11111',
                from: 'sender111111',
                to: 'receiver1111',
                asset_ids: ['4000000000002'],
                memo: 'test transfer no record',
            };
            const transferTrace = createActionTrace(CONTRACT, 'logtransfer', transferData);
            await processActionTrace(processor, db, transferBlock, transferTx, transferTrace);

            // Asset ownership should still change
            const assetResult = await client.query(
                'SELECT owner FROM atomicassets_assets WHERE contract = $1 AND asset_id = $2',
                [CONTRACT, '4000000000002']
            );
            expect(assetResult.rows[0].owner).to.equal('receiver1111');

            // But no transfer record
            const transferResult = await client.query(
                'SELECT * FROM atomicassets_transfers WHERE contract = $1 AND transfer_id = $2',
                [CONTRACT, transferTrace.global_sequence]
            );
            expect(transferResult.rowCount).to.equal(0);
        });
    });

    describe('logbackasset', () => {
        it('should insert a new backed token record', async () => {
            // Mint first
            const mintBlock = createBlock();
            const mintTx = createTx();
            const mintData: LogMintAssetActionData = {
                asset_id: '5000000000001',
                authorized_minter: 'minter1',
                collection_name: 'testcol11111',
                schema_name: 'testschema11',
                template_id: 1,
                new_asset_owner: 'owner1111111',
                immutable_data: [],
                mutable_data: [],
                backed_tokens: [],
                immutable_template_data: [],
            };
            const mintTrace = createActionTrace(CONTRACT, 'logmint', mintData);
            await processActionTrace(processor, db, mintBlock, mintTx, mintTrace);

            // Back with tokens
            const backBlock = createBlock();
            const backTx = createTx();
            const backData: LogBackAssetActionData = {
                asset_owner: 'owner1111111',
                asset_id: '5000000000001',
                backed_token: '10.0000 WAX',
            };
            const backTrace = createActionTrace(CONTRACT, 'logbackasset', backData);
            await processActionTrace(processor, db, backBlock, backTx, backTrace);

            const result = await client.query(
                'SELECT * FROM atomicassets_assets_backed_tokens WHERE contract = $1 AND asset_id = $2',
                [CONTRACT, '5000000000001']
            );
            expect(result.rowCount).to.equal(1);
            expect(result.rows[0].token_symbol).to.equal('WAX');
            expect(result.rows[0].amount).to.equal('100000');
        });

        it('should accumulate amounts for the same token symbol', async () => {
            // Mint first
            const mintBlock = createBlock();
            const mintTx = createTx();
            const mintData: LogMintAssetActionData = {
                asset_id: '5000000000002',
                authorized_minter: 'minter1',
                collection_name: 'testcol11111',
                schema_name: 'testschema11',
                template_id: 1,
                new_asset_owner: 'owner1111111',
                immutable_data: [],
                mutable_data: [],
                backed_tokens: [],
                immutable_template_data: [],
            };
            const mintTrace = createActionTrace(CONTRACT, 'logmint', mintData);
            await processActionTrace(processor, db, mintBlock, mintTx, mintTrace);

            // First backing
            const backBlock1 = createBlock();
            const backTx1 = createTx();
            const backData1: LogBackAssetActionData = {
                asset_owner: 'owner1111111',
                asset_id: '5000000000002',
                backed_token: '5.0000 WAX',
            };
            const backTrace1 = createActionTrace(CONTRACT, 'logbackasset', backData1);
            await processActionTrace(processor, db, backBlock1, backTx1, backTrace1);

            // Second backing (same token)
            const backBlock2 = createBlock();
            const backTx2 = createTx();
            const backData2: LogBackAssetActionData = {
                asset_owner: 'owner1111111',
                asset_id: '5000000000002',
                backed_token: '3.0000 WAX',
            };
            const backTrace2 = createActionTrace(CONTRACT, 'logbackasset', backData2);
            await processActionTrace(processor, db, backBlock2, backTx2, backTrace2);

            const result = await client.query(
                'SELECT amount FROM atomicassets_assets_backed_tokens WHERE contract = $1 AND asset_id = $2 AND token_symbol = $3',
                [CONTRACT, '5000000000002', 'WAX']
            );
            expect(result.rowCount).to.equal(1);
            // 50000 + 30000 = 80000
            expect(result.rows[0].amount).to.equal('80000');
        });
    });
});
