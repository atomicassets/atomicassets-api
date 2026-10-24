import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import {
    createActionTrace,
    createBlock,
    createMockModuleLoader,
    createMockNotifier,
    createProcessorTestContext,
    createTestTransaction,
    createTx,
    processActionTrace,
} from '../../test-helper';
import { offerProcessor } from './offers';
import DataProcessor, { ProcessingState } from '../../../processor';
import { ContractDBTransaction } from '../../../database';
import { OfferState } from '../index';
import { ShipBlock } from '../../../../types/ship';
import { EosioActionTrace } from '../../../../types/eosio';
import {
    LogNewOfferActionData,
    AcceptOfferActionData,
    DeclineOfferActionData,
    CancelOfferActionData,
    LogTransferActionData,
} from '../types/actions';

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

describe('offerProcessor', () => {
    let client: Client;
    let processor: DataProcessor;
    let db: ContractDBTransaction;
    let destroyProcessor: () => any;

    beforeAll(async () => {
        const ctx = createProcessorTestContext();
        client = ctx.client;
        await client.connect();
    });

    afterAll(async () => {
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

    describe('invalidation timestamps', () => {
        const SENDER = 'sender111111';
        const RECEIVER = 'receiver1111';

        async function createOfferWithAsset(offerId: string, assetId: string): Promise<{ created: ShipBlock }> {
            await client.query(
                `INSERT INTO atomicassets_assets (contract, asset_id, collection_name, schema_name, owner,
                    transferred_at_block, transferred_at_time, updated_at_block, updated_at_time, minted_at_block, minted_at_time)
                VALUES ($1, $2, 'testcol11111', 'testschema11', $3, 1, 1, 1, 1, 1, 1)`,
                [CONTRACT, assetId, SENDER]
            );
            const created = createBlock({ timestamp: '2023-01-01T00:00:00.000' });
            const data: LogNewOfferActionData = {
                offer_id: offerId,
                sender: SENDER,
                recipient: RECEIVER,
                sender_asset_ids: [assetId],
                recipient_asset_ids: [],
                memo: 'trade',
            };
            await processActionTrace(processor, db, created, createTx(), createActionTrace(CONTRACT, 'lognewoffer', data));
            return { created };
        }

        function moveAsset(assetId: string, owner: string): Promise<unknown> {
            return client.query('UPDATE atomicassets_assets SET owner = $3 WHERE contract = $1 AND asset_id = $2', [CONTRACT, assetId, owner]);
        }

        function transferTrace(assetId: string, from: string, to: string): EosioActionTrace<LogTransferActionData> {
            return createActionTrace(CONTRACT, 'logtransfer', {
                collection_name: 'testcol11111',
                from,
                to,
                asset_ids: [assetId],
                memo: '',
            });
        }

        async function readOffer(offerId: string): Promise<{ state: number; block: number; time: number }> {
            const result = await client.query(
                'SELECT state, updated_at_block, updated_at_time FROM atomicassets_offers WHERE contract = $1 AND offer_id = $2',
                [CONTRACT, offerId]
            );
            const row = result.rows[0];
            return { state: row.state, block: Number(row.updated_at_block), time: Number(row.updated_at_time) };
        }

        it('sets the update block and time of the newest transfer block when an offer turns invalid', async () => {
            await createOfferWithAsset('300001', '5000001');
            await moveAsset('5000001', RECEIVER);

            // Two blocks in one commit batch: the newer block must win.
            const older = createBlock({ timestamp: '2023-02-01T00:00:00.000' });
            const newer = createBlock({ timestamp: '2023-02-02T00:00:00.000' });
            processor.processActionTrace(older, createTx(), transferTrace('5000001', SENDER, RECEIVER));
            processor.processActionTrace(newer, createTx(), transferTrace('5000001', SENDER, RECEIVER));
            await processor.executeHeadQueue(db);

            expect(await readOffer('300001')).to.deep.equal({
                state: OfferState.INVALID.valueOf(),
                block: newer.block_num,
                time: new Date('2023-02-02T00:00:00.000Z').getTime(),
            });
        });

        it('sets the update block and time of the burn block when a burn turns an offer invalid', async () => {
            await createOfferWithAsset('300002', '5000002');
            await client.query('UPDATE atomicassets_assets SET owner = NULL WHERE contract = $1 AND asset_id = $2', [CONTRACT, '5000002']);

            const burnBlock = createBlock({ timestamp: '2023-03-01T00:00:00.000' });
            const burn = createActionTrace(CONTRACT, 'logburnasset', {
                asset_owner: SENDER,
                asset_id: '5000002',
                collection_name: 'testcol11111',
                schema_name: 'testschema11',
                template_id: -1,
                backed_tokens: [],
                old_immutable_data: [],
                old_mutable_data: [],
                asset_ram_payer: SENDER,
            });
            await processActionTrace(processor, db, burnBlock, createTx(), burn);

            expect(await readOffer('300002')).to.deep.equal({
                state: OfferState.INVALID.valueOf(),
                block: burnBlock.block_num,
                time: new Date('2023-03-01T00:00:00.000Z').getTime(),
            });
        });

        it('keeps the invalidation block and time when the asset returns and the offer turns pending', async () => {
            await createOfferWithAsset('300003', '5000003');
            await moveAsset('5000003', RECEIVER);
            const invalidBlock = createBlock({ timestamp: '2023-04-01T00:00:00.000' });
            await processActionTrace(processor, db, invalidBlock, createTx(), transferTrace('5000003', SENDER, RECEIVER));

            await moveAsset('5000003', SENDER);
            const returnBlock = createBlock({ timestamp: '2023-04-05T00:00:00.000' });
            await processActionTrace(processor, db, returnBlock, createTx(), transferTrace('5000003', RECEIVER, SENDER));

            expect(await readOffer('300003')).to.deep.equal({
                state: OfferState.PENDING.valueOf(),
                block: invalidBlock.block_num,
                time: new Date('2023-04-01T00:00:00.000Z').getTime(),
            });
        });

        it('leaves an accepted, declined, or cancelled offer unchanged when its asset moves', async () => {
            const cases: Array<[string, string, string, string]> = [
                ['300004', '5000004', 'acceptoffer', 'ACCEPTED'],
                ['300005', '5000005', 'declineoffer', 'DECLINED'],
                ['300006', '5000006', 'canceloffer', 'CANCELLED'],
            ];
            for (const [offerId, assetId, action, state] of cases) {
                await createOfferWithAsset(offerId, assetId);
                const closeBlock = createBlock({ timestamp: '2023-05-01T00:00:00.000' });
                await processActionTrace(processor, db, closeBlock, createTx(), createActionTrace(CONTRACT, action, { offer_id: offerId }));
                await moveAsset(assetId, RECEIVER);
                await processActionTrace(processor, db, createBlock({ timestamp: '2023-05-09T00:00:00.000' }), createTx(), transferTrace(assetId, SENDER, RECEIVER));

                expect(await readOffer(offerId)).to.deep.equal({
                    state: (OfferState as any)[state].valueOf(),
                    block: closeBlock.block_num,
                    time: new Date('2023-05-01T00:00:00.000Z').getTime(),
                });
            }
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

        it('issues SET LOCAL statement_timeout before the chunked lookup', async () => {
            // Hot assets (e.g. WAX 1099538624457 with 36k historical offers)
            // can push the chunked lookup past the 30s cluster default, which
            // caused a crash-loop on 2026-04-23 at block #430970869. The onCommit
            // handler opts into a 300s budget scoped to the current transaction
            // via SET LOCAL (raised from 180s in migration 1.3.33 work after a
            // 2026-04-24 12:10 UTC recurrence); verify it's emitted before the
            // first related-offer query so the filler gets the extra budget.
            const spy = spyOnQuery(db);
            try {
                const assetIds = ['4000001', '4000002', '4000003'];
                const data: LogTransferActionData = {
                    collection_name: 'testcol11111',
                    from: 'sender111111',
                    to: 'receiver1111',
                    asset_ids: assetIds,
                    memo: 'hot asset guard',
                };
                const trace = createActionTrace(CONTRACT, 'logtransfer', data);
                await processActionTrace(processor, db, createBlock(), createTx(), trace);

                const setLocalIdx = spy.calls.findIndex(c =>
                    typeof c.text === 'string' && c.text.includes("SET LOCAL statement_timeout = '300s'")
                );
                const relatedIdx = spy.calls.findIndex(c =>
                    typeof c.text === 'string' && c.text.includes('SELECT offer.offer_id, offer.state')
                );
                expect(setLocalIdx).to.be.greaterThan(-1);
                expect(relatedIdx).to.be.greaterThan(-1);
                expect(setLocalIdx).to.be.lessThan(relatedIdx);
            } finally {
                spy.restore();
            }
        });

        it('does NOT issue SET LOCAL when no assets were transferred', async () => {
            // Symmetric with the skip-the-query-entirely test: the onCommit
            // early-return short-circuits before any DB work, including the
            // timeout bump. Pays nothing when there's nothing to look up.
            const spy = spyOnQuery(db);
            try {
                const data: LogTransferActionData = {
                    collection_name: 'testcol11111',
                    from: 'sender111111',
                    to: 'receiver1111',
                    asset_ids: [],
                    memo: 'no assets',
                };
                const trace = createActionTrace(CONTRACT, 'logtransfer', data);
                await processActionTrace(processor, db, createBlock(), createTx(), trace);

                const setLocalIdx = spy.calls.findIndex(c =>
                    typeof c.text === 'string' && c.text.includes('SET LOCAL statement_timeout')
                );
                expect(setLocalIdx).to.equal(-1);
            } finally {
                spy.restore();
            }
        });
    });
});
