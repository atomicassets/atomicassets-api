import 'mocha';
import { expect } from 'chai';
import { Client } from 'pg';
import {
    createProcessorTestContext,
    createMockNotifier,
    createBlock,
    createTx,
    createActionTrace,
    createContractRow,
    processActionTrace,
    processContractRow,
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
    LogMoveActionData,
} from '../types/actions';
import { HoldersTableRow } from '../types/tables';
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

    // -----------------------------------------------------------------------
    // Shared helper: mint an asset with a known owner so move/holder handlers
    // have a target row to update. Mirrors the chunking-block helper but is
    // available to all the move/holder describe blocks below.
    // -----------------------------------------------------------------------
    async function mintAsset(assetId: string, owner: string): Promise<void> {
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

    /**
     * Process a logmove action for the given asset_ids and return the move trace
     * (move_id === trace.global_sequence). `block` lets callers pin the timestamp.
     */
    async function moveAssets(
        from: string,
        to: string,
        assetIds: string[],
        memo: string,
        block = createBlock()
    ): Promise<ReturnType<typeof createActionTrace>> {
        const moveTrace = createActionTrace(CONTRACT, 'logmove', {
            collection_name: 'testcol11111',
            owner: from,
            from,
            to,
            asset_ids: assetIds,
            memo,
        } as LogMoveActionData);
        await processActionTrace(processor, db, block, createTx(), moveTrace);
        return moveTrace;
    }

    /**
     * Process a `holders` table delta for an asset. `present` toggles the row's
     * presence (rental start vs. lease end). `block` lets callers pin the timestamp.
     */
    async function processHoldersDelta(
        assetId: string,
        holder: string,
        owner: string,
        present: boolean,
        block = createBlock()
    ): Promise<void> {
        const delta = createContractRow(
            CONTRACT,
            'holders',
            { asset_id: assetId, holder, owner } as HoldersTableRow,
            present
        );
        await processContractRow(processor, db, block, delta);
    }

    describe('logmove', () => {
        it('inserts a move row and move-asset rows and updates holder=to for each asset', async () => {
            const assetIds = ['9100000000001', '9100000000002', '9100000000003'];
            for (const id of assetIds) {
                await mintAsset(id, 'owner1111111');
            }

            const moveBlock = createBlock({ timestamp: '2023-08-01T09:00:00.000' });
            const moveTrace = await moveAssets('owner1111111', 'renter111111', assetIds, 'lease out', moveBlock);

            // One move row, move_id === global_sequence.
            const moveResult = await client.query(
                'SELECT * FROM atomicassets_moves WHERE contract = $1 AND move_id = $2',
                [CONTRACT, moveTrace.global_sequence]
            );
            expect(moveResult.rowCount).to.equal(1);
            const move = moveResult.rows[0];
            expect(String(move.move_id)).to.equal(String(moveTrace.global_sequence));
            expect(move.sender).to.equal('owner1111111');
            expect(move.recipient).to.equal('renter111111');
            expect(move.memo).to.equal('lease out');
            expect(Number(move.created_at_block)).to.equal(moveBlock.block_num);

            // N move-asset rows with 1-based index.
            const moveAssetsResult = await client.query(
                'SELECT asset_id, index FROM atomicassets_moves_assets WHERE contract = $1 AND move_id = $2 ORDER BY index',
                [CONTRACT, moveTrace.global_sequence]
            );
            expect(moveAssetsResult.rowCount).to.equal(3);
            expect(moveAssetsResult.rows.map(r => String(r.asset_id))).to.deep.equal(assetIds);
            expect(moveAssetsResult.rows.map(r => r.index)).to.deep.equal([1, 2, 3]);

            // Every asset's holder reflects the recipient; owner is unchanged.
            const assetResult = await client.query(
                'SELECT asset_id, owner, holder FROM atomicassets_assets WHERE contract = $1 AND asset_id = ANY($2)',
                [CONTRACT, assetIds]
            );
            expect(assetResult.rowCount).to.equal(3);
            for (const row of assetResult.rows) {
                expect(row.holder).to.equal('renter111111');
                expect(row.owner).to.equal('owner1111111');
            }
        });

        it('truncates memo to 256 chars', async () => {
            await mintAsset('9100000000010', 'owner1111111');

            const longMemo = 'x'.repeat(300);
            const moveTrace = await moveAssets('owner1111111', 'renter111111', ['9100000000010'], longMemo);

            const moveResult = await client.query(
                'SELECT memo FROM atomicassets_moves WHERE contract = $1 AND move_id = $2',
                [CONTRACT, moveTrace.global_sequence]
            );
            expect(moveResult.rows[0].memo).to.have.lengthOf(256);
            expect(moveResult.rows[0].memo).to.equal('x'.repeat(256));
        });

        it('does no DB work and does not throw on empty asset_ids', async () => {
            const moveTrace = await moveAssets('owner1111111', 'renter111111', [], 'empty move');

            const moveResult = await client.query(
                'SELECT COUNT(*)::int AS n FROM atomicassets_moves WHERE contract = $1 AND move_id = $2',
                [CONTRACT, moveTrace.global_sequence]
            );
            expect(moveResult.rows[0].n).to.equal(0);

            const moveAssetsResult = await client.query(
                'SELECT COUNT(*)::int AS n FROM atomicassets_moves_assets WHERE contract = $1 AND move_id = $2',
                [CONTRACT, moveTrace.global_sequence]
            );
            expect(moveAssetsResult.rows[0].n).to.equal(0);
        });

        it('updates EVERY asset holder when asset_ids exceed ASSET_CHUNK_SIZE (>100)', async () => {
            // 250 ids -> 3 UPDATE chunks; assert all 250 holders updated.
            const assetIds = Array.from({ length: 250 }, (_, i) => String(9_200_000_000 + i));
            for (const id of assetIds) {
                await mintAsset(id, 'owner1111111');
            }

            const moveTrace = await moveAssets('owner1111111', 'renter111111', assetIds, 'big lease');

            const holders = await client.query(
                'SELECT DISTINCT holder FROM atomicassets_assets WHERE contract = $1 AND asset_id = ANY($2)',
                [CONTRACT, assetIds]
            );
            expect(holders.rowCount).to.equal(1);
            expect(holders.rows[0].holder).to.equal('renter111111');

            // every move-asset row persisted
            const moveAssetCount = await client.query(
                'SELECT COUNT(*)::int AS n FROM atomicassets_moves_assets WHERE contract = $1 AND move_id = $2',
                [CONTRACT, moveTrace.global_sequence]
            );
            expect(moveAssetCount.rows[0].n).to.equal(250);
        });

        it('inserts EVERY move-asset row when count exceeds MOVE_INSERT_CHUNK_SIZE (>1000)', async () => {
            // 1500 ids -> 2 INSERT chunks (1000 + 500); assert all 1500 rows present.
            const assetIds = Array.from({ length: 1500 }, (_, i) => String(9_300_000_000 + i));
            for (const id of assetIds) {
                await mintAsset(id, 'owner1111111');
            }

            const moveTrace = await moveAssets('owner1111111', 'renter111111', assetIds, 'huge lease');

            const moveAssetCount = await client.query(
                'SELECT COUNT(*)::int AS n FROM atomicassets_moves_assets WHERE contract = $1 AND move_id = $2',
                [CONTRACT, moveTrace.global_sequence]
            );
            expect(moveAssetCount.rows[0].n).to.equal(1500);

            // index range is contiguous 1..1500
            const idxResult = await client.query(
                'SELECT MIN(index) AS lo, MAX(index) AS hi FROM atomicassets_moves_assets WHERE contract = $1 AND move_id = $2',
                [CONTRACT, moveTrace.global_sequence]
            );
            expect(idxResult.rows[0].lo).to.equal(1);
            expect(idxResult.rows[0].hi).to.equal(1500);
        });

        it('updates holder but writes no moves rows when store_transfers is false', async () => {
            // Re-create processor with store_transfers = false.
            if (destroyProcessor) {
                destroyProcessor();
            }
            processor = new DataProcessor(ProcessingState.HEAD, createMockModuleLoader());
            db = createTestTransaction(client);
            const core = createMockCore({ store_transfers: false });
            destroyProcessor = assetProcessor(core as any, processor, createMockNotifier());

            await mintAsset('9100000000020', 'owner1111111');

            const moveTrace = await moveAssets('owner1111111', 'renter111111', ['9100000000020'], 'silent lease');

            // holder still updated
            const assetResult = await client.query(
                'SELECT holder, owner FROM atomicassets_assets WHERE contract = $1 AND asset_id = $2',
                [CONTRACT, '9100000000020']
            );
            expect(assetResult.rows[0].holder).to.equal('renter111111');
            expect(assetResult.rows[0].owner).to.equal('owner1111111');

            // but no moves bookkeeping rows
            const moveResult = await client.query(
                'SELECT COUNT(*)::int AS n FROM atomicassets_moves WHERE contract = $1 AND move_id = $2',
                [CONTRACT, moveTrace.global_sequence]
            );
            expect(moveResult.rows[0].n).to.equal(0);
            const moveAssetsResult = await client.query(
                'SELECT COUNT(*)::int AS n FROM atomicassets_moves_assets WHERE contract = $1 AND move_id = $2',
                [CONTRACT, moveTrace.global_sequence]
            );
            expect(moveAssetsResult.rows[0].n).to.equal(0);
        });
    });

    describe('holders table delta', () => {
        it('present -> sets holder = delta.value.holder', async () => {
            await mintAsset('9400000000001', 'owner1111111');

            const block = createBlock({ timestamp: '2023-09-01T00:00:00.000' });
            await processHoldersDelta('9400000000001', 'renter111111', 'owner1111111', true, block);

            const result = await client.query(
                'SELECT holder, owner, updated_at_block FROM atomicassets_assets WHERE contract = $1 AND asset_id = $2',
                [CONTRACT, '9400000000001']
            );
            expect(result.rows[0].holder).to.equal('renter111111');
            // owner must NOT be touched by the holders handler
            expect(result.rows[0].owner).to.equal('owner1111111');
            expect(Number(result.rows[0].updated_at_block)).to.equal(block.block_num);
        });

        it('!present -> holder reverts to the asset current owner (not the stale holders-row owner)', async () => {
            await mintAsset('9400000000002', 'owner1111111');

            // First rent it out: holder = renter.
            await processHoldersDelta('9400000000002', 'renter111111', 'owner1111111', true);

            // sanity: holder is the renter now
            const mid = await client.query(
                'SELECT holder FROM atomicassets_assets WHERE contract = $1 AND asset_id = $2',
                [CONTRACT, '9400000000002']
            );
            expect(mid.rows[0].holder).to.equal('renter111111');

            // Lease ends: holders row removed. delta.value.owner is intentionally a
            // STALE value to prove the handler reads the asset's current owner, not
            // delta.value.owner.
            await processHoldersDelta('9400000000002', 'renter111111', 'staleowner11', false);

            const result = await client.query(
                'SELECT holder, owner FROM atomicassets_assets WHERE contract = $1 AND asset_id = $2',
                [CONTRACT, '9400000000002']
            );
            // reverts to the real owner read from the asset row, NOT delta.value.owner
            expect(result.rows[0].holder).to.equal('owner1111111');
            expect(result.rows[0].owner).to.equal('owner1111111');
        });

        it('!present for an unknown asset is a no-op (no row, no throw)', async () => {
            await processHoldersDelta('9499999999999', 'renter111111', 'owner1111111', false);

            const result = await client.query(
                'SELECT COUNT(*)::int AS n FROM atomicassets_assets WHERE contract = $1 AND asset_id = $2',
                [CONTRACT, '9499999999999']
            );
            expect(result.rows[0].n).to.equal(0);
        });
    });

    describe('rental lifecycle (lockstep holder reconciliation)', () => {
        it('mint -> move -> holders present -> holders !present reconciles holder in lockstep', async () => {
            const assetId = '9500000000001';

            // 1. Mint: holder === owner.
            await mintAsset(assetId, 'owner1111111');
            let row = (await client.query(
                'SELECT owner, holder FROM atomicassets_assets WHERE contract = $1 AND asset_id = $2',
                [CONTRACT, assetId]
            )).rows[0];
            expect(row.owner).to.equal('owner1111111');
            expect(row.holder).to.equal('owner1111111');

            // 2. logmove: holder becomes the recipient, owner unchanged.
            await moveAssets('owner1111111', 'renter111111', [assetId], 'lease');
            row = (await client.query(
                'SELECT owner, holder FROM atomicassets_assets WHERE contract = $1 AND asset_id = $2',
                [CONTRACT, assetId]
            )).rows[0];
            expect(row.owner).to.equal('owner1111111');
            expect(row.holder).to.equal('renter111111');

            // 3. holders present delta confirms the rental (authoritative source).
            await processHoldersDelta(assetId, 'renter111111', 'owner1111111', true);
            row = (await client.query(
                'SELECT owner, holder FROM atomicassets_assets WHERE contract = $1 AND asset_id = $2',
                [CONTRACT, assetId]
            )).rows[0];
            expect(row.owner).to.equal('owner1111111');
            expect(row.holder).to.equal('renter111111');

            // 4. logtransfer to a new owner while still rented (changes owner+holder),
            //    then holders !present (lease ends) -> holder reconciles to the new owner.
            const transferTrace = createActionTrace(CONTRACT, 'logtransfer', {
                collection_name: 'testcol11111',
                from: 'owner1111111',
                to: 'newowner1111',
                asset_ids: [assetId],
                memo: 'sale',
            } as LogTransferActionData);
            await processActionTrace(processor, db, createBlock(), createTx(), transferTrace);
            row = (await client.query(
                'SELECT owner, holder FROM atomicassets_assets WHERE contract = $1 AND asset_id = $2',
                [CONTRACT, assetId]
            )).rows[0];
            // logtransfer optimistically sets both owner and holder to the recipient
            expect(row.owner).to.equal('newowner1111');
            expect(row.holder).to.equal('newowner1111');

            // 5. holders !present -> holder reverts to the CURRENT owner.
            await processHoldersDelta(assetId, 'renter111111', 'owner1111111', false);
            row = (await client.query(
                'SELECT owner, holder FROM atomicassets_assets WHERE contract = $1 AND asset_id = $2',
                [CONTRACT, assetId]
            )).rows[0];
            expect(row.owner).to.equal('newowner1111');
            expect(row.holder).to.equal('newowner1111');
        });

        it('burn then holders !present clears holder to null in lockstep with owner', async () => {
            const assetId = '9500000000002';
            await mintAsset(assetId, 'owner1111111');

            // burn: owner and holder both cleared to null
            const burnTrace = createActionTrace(CONTRACT, 'logburnasset', {
                asset_owner: 'owner1111111',
                asset_id: assetId,
                collection_name: 'testcol11111',
                schema_name: 'testschema11',
                template_id: 1,
                backed_tokens: [],
                asset_ram_payer: 'minter1',
                old_immutable_data: [],
                old_mutable_data: [],
            } as LogBurnAssetActionData);
            await processActionTrace(processor, db, createBlock(), createTx(), burnTrace);

            let row = (await client.query(
                'SELECT owner, holder FROM atomicassets_assets WHERE contract = $1 AND asset_id = $2',
                [CONTRACT, assetId]
            )).rows[0];
            expect(row.owner).to.be.null;
            expect(row.holder).to.be.null;

            // holders !present after burn -> reads current owner (null) -> holder stays null
            await processHoldersDelta(assetId, 'renter111111', 'owner1111111', false);

            row = (await client.query(
                'SELECT owner, holder FROM atomicassets_assets WHERE contract = $1 AND asset_id = $2',
                [CONTRACT, assetId]
            )).rows[0];
            expect(row.owner).to.be.null;
            expect(row.holder).to.be.null;
        });
    });
});
