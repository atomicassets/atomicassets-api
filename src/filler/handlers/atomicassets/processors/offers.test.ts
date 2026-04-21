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
import { offerProcessor } from './offers';
import DataProcessor, { ProcessingState } from '../../../processor';
import { ContractDBTransaction } from '../../../database';
import { OfferState } from '../index';
import {
    LogNewOfferActionData,
    AcceptOfferActionData,
    DeclineOfferActionData,
    CancelOfferActionData,
    LogTransferActionData,
} from '../types/actions';
import { ModuleLoader } from '../../../modules';

const CONTRACT = 'atomicassets';

function createMockCore(overrides: Record<string, any> = {}): any {
    return {
        args: {
            atomicassets_account: CONTRACT,
            store_transfers: true,
            store_logs: false,
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

describe('offerProcessor', () => {
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
        destroyProcessor = offerProcessor(core as any, processor, notifier);
    });

    afterEach(async () => {
        if (destroyProcessor) {
            destroyProcessor();
        }
        await client.query('ROLLBACK');
    });

    describe('lognewoffer', () => {
        it('should insert a new offer with pending state', async () => {
            const block = createBlock();
            const tx = createTx();
            const data: LogNewOfferActionData = {
                offer_id: '100001',
                sender: 'sender111111',
                recipient: 'receiver1111',
                sender_asset_ids: ['1001', '1002'],
                recipient_asset_ids: ['2001'],
                memo: 'trade me',
            };
            const trace = createActionTrace(CONTRACT, 'lognewoffer', data);

            await processActionTrace(processor, db, block, tx, trace);

            const offerResult = await client.query(
                'SELECT * FROM atomicassets_offers WHERE contract = $1 AND offer_id = $2',
                [CONTRACT, '100001']
            );
            expect(offerResult.rowCount).to.equal(1);
            const offer = offerResult.rows[0];
            expect(offer.sender).to.equal('sender111111');
            expect(offer.recipient).to.equal('receiver1111');
            expect(offer.memo).to.equal('trade me');
            expect(offer.state).to.equal(OfferState.PENDING.valueOf());
            expect(Number(offer.created_at_block)).to.equal(block.block_num);
            expect(Number(offer.updated_at_block)).to.equal(block.block_num);
        });

        it('should insert offer assets for both sender and recipient', async () => {
            const block = createBlock();
            const tx = createTx();
            const data: LogNewOfferActionData = {
                offer_id: '100002',
                sender: 'sender111111',
                recipient: 'receiver1111',
                sender_asset_ids: ['1001', '1002'],
                recipient_asset_ids: ['2001'],
                memo: 'trade',
            };
            const trace = createActionTrace(CONTRACT, 'lognewoffer', data);

            await processActionTrace(processor, db, block, tx, trace);

            const assetsResult = await client.query(
                'SELECT * FROM atomicassets_offers_assets WHERE contract = $1 AND offer_id = $2 ORDER BY owner, index',
                [CONTRACT, '100002']
            );
            expect(assetsResult.rowCount).to.equal(3);

            // Recipient asset
            const recipientAssets = assetsResult.rows.filter((r: any) => r.owner === 'receiver1111');
            expect(recipientAssets).to.have.length(1);
            expect(recipientAssets[0].asset_id).to.equal('2001');

            // Sender assets
            const senderAssets = assetsResult.rows.filter((r: any) => r.owner === 'sender111111');
            expect(senderAssets).to.have.length(2);
            expect(senderAssets.map((r: any) => r.asset_id)).to.include.members(['1001', '1002']);
        });

        it('should truncate memo to 256 characters', async () => {
            const block = createBlock();
            const tx = createTx();
            const longMemo = 'x'.repeat(300);
            const data: LogNewOfferActionData = {
                offer_id: '100003',
                sender: 'sender111111',
                recipient: 'receiver1111',
                sender_asset_ids: ['1001'],
                recipient_asset_ids: [],
                memo: longMemo,
            };
            const trace = createActionTrace(CONTRACT, 'lognewoffer', data);

            await processActionTrace(processor, db, block, tx, trace);

            const result = await client.query(
                'SELECT memo FROM atomicassets_offers WHERE contract = $1 AND offer_id = $2',
                [CONTRACT, '100003']
            );
            expect(result.rows[0].memo).to.have.length(256);
        });
    });

    describe('acceptoffer', () => {
        it('should update offer state to ACCEPTED', async () => {
            // First create an offer
            const createBlock_ = createBlock();
            const createTx_ = createTx();
            const createData: LogNewOfferActionData = {
                offer_id: '200001',
                sender: 'sender111111',
                recipient: 'receiver1111',
                sender_asset_ids: ['1001'],
                recipient_asset_ids: [],
                memo: 'test',
            };
            const createTrace = createActionTrace(CONTRACT, 'lognewoffer', createData);
            await processActionTrace(processor, db, createBlock_, createTx_, createTrace);

            // Accept the offer
            const acceptBlock = createBlock({ timestamp: '2023-08-01T00:00:00.000' });
            const acceptTx = createTx();
            const acceptData: AcceptOfferActionData = {
                offer_id: '200001',
            };
            const acceptTrace = createActionTrace(CONTRACT, 'acceptoffer', acceptData);
            await processActionTrace(processor, db, acceptBlock, acceptTx, acceptTrace);

            const result = await client.query(
                'SELECT state, updated_at_block FROM atomicassets_offers WHERE contract = $1 AND offer_id = $2',
                [CONTRACT, '200001']
            );
            expect(result.rows[0].state).to.equal(OfferState.ACCEPTED.valueOf());
            expect(Number(result.rows[0].updated_at_block)).to.equal(acceptBlock.block_num);
        });
    });

    describe('declineoffer', () => {
        it('should update offer state to DECLINED', async () => {
            // Create
            const createBlock_ = createBlock();
            const createTx_ = createTx();
            const createData: LogNewOfferActionData = {
                offer_id: '200002',
                sender: 'sender111111',
                recipient: 'receiver1111',
                sender_asset_ids: ['1001'],
                recipient_asset_ids: [],
                memo: 'test',
            };
            const createTrace = createActionTrace(CONTRACT, 'lognewoffer', createData);
            await processActionTrace(processor, db, createBlock_, createTx_, createTrace);

            // Decline
            const declineBlock = createBlock();
            const declineTx = createTx();
            const declineData: DeclineOfferActionData = {
                offer_id: '200002',
            };
            const declineTrace = createActionTrace(CONTRACT, 'declineoffer', declineData);
            await processActionTrace(processor, db, declineBlock, declineTx, declineTrace);

            const result = await client.query(
                'SELECT state FROM atomicassets_offers WHERE contract = $1 AND offer_id = $2',
                [CONTRACT, '200002']
            );
            expect(result.rows[0].state).to.equal(OfferState.DECLINED.valueOf());
        });
    });

    describe('canceloffer', () => {
        it('should update offer state to CANCELLED', async () => {
            // Create
            const createBlock_ = createBlock();
            const createTx_ = createTx();
            const createData: LogNewOfferActionData = {
                offer_id: '200003',
                sender: 'sender111111',
                recipient: 'receiver1111',
                sender_asset_ids: ['1001'],
                recipient_asset_ids: [],
                memo: 'test',
            };
            const createTrace = createActionTrace(CONTRACT, 'lognewoffer', createData);
            await processActionTrace(processor, db, createBlock_, createTx_, createTrace);

            // Cancel
            const cancelBlock = createBlock();
            const cancelTx = createTx();
            const cancelData: CancelOfferActionData = {
                offer_id: '200003',
            };
            const cancelTrace = createActionTrace(CONTRACT, 'canceloffer', cancelData);
            await processActionTrace(processor, db, cancelBlock, cancelTx, cancelTrace);

            const result = await client.query(
                'SELECT state FROM atomicassets_offers WHERE contract = $1 AND offer_id = $2',
                [CONTRACT, '200003']
            );
            expect(result.rows[0].state).to.equal(OfferState.CANCELLED.valueOf());
        });
    });

    describe('logtransfer chunking', () => {
        // The onCommit handler in offers.ts chunks `transferredAssets` at
        // CHUNK_SIZE=100 to bound planner variance on the offers_assets lookup.
        // These tests verify the chunking boundaries and deduplication logic
        // without relying on realistic DB fixtures (with no matching offers,
        // each chunked related-offers lookup still runs, but no follow-up
        // invalid-offer lookup or state update occurs).

        function spyOnQuery(target: ContractDBTransaction): { calls: Array<{ text: string; values: any[] }>; restore: () => void } {
            const calls: Array<{ text: string; values: any[] }> = [];
            const originalQuery = target.query.bind(target);
            (target as any).query = async (...args: any[]) => {
                const [text, values = []] = args;
                calls.push({ text, values });
                return originalQuery(...args);
            };
            return { calls, restore: () => { (target as any).query = originalQuery; } };
        }

        function countRelatedOfferQueries(calls: Array<{ text: string; values: any[] }>): number {
            // Identify the chunked "find related offers by asset_id" queries
            // from the onCommit handler. Match by the unique projection
            // `SELECT offer.offer_id, offer.state` which doesn't appear in
            // any other query in the processor, and verify the parameter
            // shape is (contract, asset_id_array).
            return calls.filter(call =>
                call.text.includes('SELECT offer.offer_id, offer.state')
                && Array.isArray(call.values)
                && call.values.length === 2
                && Array.isArray(call.values[1])
            ).length;
        }

        it('issues one chunked query for asset counts at or below CHUNK_SIZE', async () => {
            const spy = spyOnQuery(db);
            try {
                const assetIds = Array.from({ length: 100 }, (_, i) => String(1_000_000 + i));
                const data: LogTransferActionData = {
                    collection_name: 'testcol11111',
                    from: 'sender111111',
                    to: 'receiver1111',
                    asset_ids: assetIds,
                    memo: 'transfer',
                };
                const trace = createActionTrace(CONTRACT, 'logtransfer', data);
                await processActionTrace(processor, db, createBlock(), createTx(), trace);

                expect(countRelatedOfferQueries(spy.calls)).to.equal(1);
            } finally {
                spy.restore();
            }
        });

        it('issues multiple chunked queries when assets exceed CHUNK_SIZE', async () => {
            const spy = spyOnQuery(db);
            try {
                // 201 unique assets -> ceil(201/100) = 3 chunks.
                const assetIds = Array.from({ length: 201 }, (_, i) => String(2_000_000 + i));
                const data: LogTransferActionData = {
                    collection_name: 'testcol11111',
                    from: 'sender111111',
                    to: 'receiver1111',
                    asset_ids: assetIds,
                    memo: 'big transfer',
                };
                const trace = createActionTrace(CONTRACT, 'logtransfer', data);
                await processActionTrace(processor, db, createBlock(), createTx(), trace);

                expect(countRelatedOfferQueries(spy.calls)).to.equal(3);
            } finally {
                spy.restore();
            }
        });

        it('deduplicates asset_ids across multiple logtransfer traces in the same block', async () => {
            const spy = spyOnQuery(db);
            try {
                // Three logtransfer traces in the same block referencing
                // overlapping asset_ids. Enqueue all three without flushing
                // between them, then executeHeadQueue once so they share a
                // single commit round and the Set-dedup path applies.
                // Union has 5 unique ids (< CHUNK_SIZE) → 1 chunked query.
                const block = createBlock();
                const tx = createTx();
                const traces: Array<string[]> = [
                    ['3000001', '3000002', '3000003'],
                    ['3000002', '3000003', '3000004'],
                    ['3000001', '3000004', '3000005'],
                ];
                for (const ids of traces) {
                    const data: LogTransferActionData = {
                        collection_name: 'testcol11111',
                        from: 'sender111111',
                        to: 'receiver1111',
                        asset_ids: ids,
                        memo: 'dup transfer',
                    };
                    const trace = createActionTrace(CONTRACT, 'logtransfer', data);
                    processor.processActionTrace(block, tx, trace);
                }
                await processor.executeHeadQueue(db);

                expect(countRelatedOfferQueries(spy.calls)).to.equal(1);
            } finally {
                spy.restore();
            }
        });

        it('skips the query entirely when no assets were transferred', async () => {
            const spy = spyOnQuery(db);
            try {
                // Fire a logtransfer trace with an empty asset_ids array.
                // The logtransfer listener pushes nothing to transferredAssets,
                // so onCommit hits the length === 0 early-return and never
                // issues the chunked related-offers lookup.
                const block = createBlock();
                const tx = createTx();
                const data: LogTransferActionData = {
                    collection_name: 'testcol11111',
                    from: 'sender111111',
                    to: 'receiver1111',
                    asset_ids: [],
                    memo: 'no assets',
                };
                const trace = createActionTrace(CONTRACT, 'logtransfer', data);
                await processActionTrace(processor, db, block, tx, trace);

                expect(countRelatedOfferQueries(spy.calls)).to.equal(0);
            } finally {
                spy.restore();
            }
        });
    });
});
