import 'mocha';
import { expect } from 'chai';
import { Client } from 'pg';
import {
    createProcessorTestContext,
    createBlock,
    createTx,
    createActionTrace,
    processActionTrace,
    processContractRow,
    createTestTransaction,
} from '../../test-helper';
import { royaltyProcessor } from './royalties';
import { logProcessor } from './logs';
import DataProcessor, { ProcessingState } from '../../../processor';
import { ContractDBTransaction } from '../../../database';
import { RoyaltyListingType, RoyaltyPayoutCategory } from '../index';
import {
    LogRoyaltyAttributeActionData,
    LogRoyaltyDustActionData,
    LogRoyaltyFoundActionData,
    LogRoyaltyTemplateActionData,
} from '../types/actions';
import { RoyaltyAttrTableRow, RoyaltyConfTableRow, RoyaltyTempTableRow } from '../types/tables';
import { ModuleLoader } from '../../../modules';

const MARKET_CONTRACT = 'atomicmarket';
const ASSETS_CONTRACT = 'atomicassets';

function createMockCore(overrides: Record<string, any> = {}): any {
    return {
        args: {
            atomicmarket_account: MARKET_CONTRACT,
            atomicassets_account: ASSETS_CONTRACT,
            delphioracle_account: 'delphioracle',
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

describe('royaltyProcessor', () => {
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
        destroyProcessor = royaltyProcessor(createMockCore(), processor);
    });

    afterEach(async () => {
        if (destroyProcessor) {
            destroyProcessor();
        }
        await client.query('ROLLBACK');
    });

    describe('config mirroring', () => {
        it('upserts one atomicmarket_royalties_config row on a royaltyconf delta', async () => {
            const block = createBlock();
            const data: RoyaltyConfTableRow = {
                collection: 'testcol11111',
                founders: [{recipient: 'founder11111', weight: 100}],
                attribute_mode: 1,
                split_founders: 500000,
                split_templates: 300000,
                split_attributes: 200000,
            };
            const delta = {
                code: MARKET_CONTRACT, scope: MARKET_CONTRACT, table: 'royaltyconf',
                primary_key: '0', payer: MARKET_CONTRACT, present: true, value: data,
            };

            await processContractRow(processor, db, block, delta);

            const result = await client.query(
                'SELECT * FROM atomicmarket_royalties_config WHERE market_contract = $1 AND collection_name = $2',
                [MARKET_CONTRACT, 'testcol11111']
            );
            expect(result.rowCount).to.equal(1);
            const row = result.rows[0];
            expect(row.founders).to.deep.equal([{recipient: 'founder11111', weight: 100}]);
            expect(row.attribute_mode).to.equal(1);
            expect(Number(row.split_founders)).to.equal(500000);
            expect(Number(row.split_templates)).to.equal(300000);
            expect(Number(row.split_attributes)).to.equal(200000);
        });

        it('deletes the row on a royaltyconf delta with present=false', async () => {
            const block = createBlock();
            const data: RoyaltyConfTableRow = {
                collection: 'testcol22222',
                founders: [],
                attribute_mode: 0,
                split_founders: 1000000,
                split_templates: 0,
                split_attributes: 0,
            };
            await processContractRow(processor, db, block, {
                code: MARKET_CONTRACT, scope: MARKET_CONTRACT, table: 'royaltyconf',
                primary_key: '0', payer: MARKET_CONTRACT, present: true, value: data,
            });

            await processContractRow(processor, db, createBlock(), {
                code: MARKET_CONTRACT, scope: MARKET_CONTRACT, table: 'royaltyconf',
                primary_key: '0', payer: MARKET_CONTRACT, present: false, value: data,
            });

            const result = await client.query(
                'SELECT * FROM atomicmarket_royalties_config WHERE market_contract = $1 AND collection_name = $2',
                [MARKET_CONTRACT, 'testcol22222']
            );
            expect(result.rowCount).to.equal(0);
        });

        it('upserts atomicmarket_royalties_templates keyed by scope + template_id; present=false deletes', async () => {
            const data: RoyaltyTempTableRow = {
                template_id: 42,
                recipients: [{recipient: 'templover111', weight: 100}],
            };
            const delta = {
                code: MARKET_CONTRACT, scope: 'testcol33333', table: 'royaltytemp',
                primary_key: '42', payer: MARKET_CONTRACT, present: true, value: data,
            };

            await processContractRow(processor, db, createBlock(), delta);

            const inserted = await client.query(
                'SELECT * FROM atomicmarket_royalties_templates WHERE market_contract = $1 AND collection_name = $2 AND template_id = $3',
                [MARKET_CONTRACT, 'testcol33333', '42']
            );
            expect(inserted.rowCount).to.equal(1);
            expect(inserted.rows[0].recipients).to.deep.equal([{recipient: 'templover111', weight: 100}]);

            await processContractRow(processor, db, createBlock(), {...delta, present: false});

            const afterDelete = await client.query(
                'SELECT * FROM atomicmarket_royalties_templates WHERE market_contract = $1 AND collection_name = $2 AND template_id = $3',
                [MARKET_CONTRACT, 'testcol33333', '42']
            );
            expect(afterDelete.rowCount).to.equal(0);
        });

        it('stores royaltyattr with rule_id = value.index, raw variant tuple in value, and hex lookup_hash as bytea; present=false deletes', async () => {
            const lookupHashHex = 'ab'.repeat(32); // 32-byte sha256-shaped hex string
            const data: RoyaltyAttrTableRow = {
                index: '7',
                source: 2,
                field: 'rarity',
                value: ['uint64', '5'],
                weight: 250000,
                recipients: [{recipient: 'attrrecip111', weight: 100}],
                lookup_hash: lookupHashHex,
            };
            const delta = {
                code: MARKET_CONTRACT, scope: 'testcol44444', table: 'royaltyattr',
                primary_key: '7', payer: MARKET_CONTRACT, present: true, value: data,
            };

            await processContractRow(processor, db, createBlock(), delta);

            const result = await client.query(
                'SELECT * FROM atomicmarket_royalties_attributes WHERE market_contract = $1 AND collection_name = $2 AND rule_id = $3',
                [MARKET_CONTRACT, 'testcol44444', '7']
            );
            expect(result.rowCount).to.equal(1);
            const row = result.rows[0];
            expect(row.source).to.equal(2);
            expect(row.field).to.equal('rarity');
            // Raw ["type", value] variant tuple round-trips with the string payload intact
            expect(row.value).to.deep.equal(['uint64', '5']);
            expect(Number(row.weight)).to.equal(250000);
            expect(Buffer.from(row.lookup_hash).toString('hex')).to.equal(lookupHashHex);

            await processContractRow(processor, db, createBlock(), {...delta, present: false});

            const afterDelete = await client.query(
                'SELECT * FROM atomicmarket_royalties_attributes WHERE market_contract = $1 AND collection_name = $2 AND rule_id = $3',
                [MARKET_CONTRACT, 'testcol44444', '7']
            );
            expect(afterDelete.rowCount).to.equal(0);
        });

        it('leaves exactly one row when the same royaltyconf delta is re-applied (replace semantics)', async () => {
            const data: RoyaltyConfTableRow = {
                collection: 'testcol55555',
                founders: [{recipient: 'founder11111', weight: 100}],
                attribute_mode: 0,
                split_founders: 1000000,
                split_templates: 0,
                split_attributes: 0,
            };
            const delta = {
                code: MARKET_CONTRACT, scope: MARKET_CONTRACT, table: 'royaltyconf',
                primary_key: '0', payer: MARKET_CONTRACT, present: true, value: data,
            };

            await processContractRow(processor, db, createBlock(), delta);
            await processContractRow(processor, db, createBlock(), delta);

            const result = await client.query(
                'SELECT * FROM atomicmarket_royalties_config WHERE market_contract = $1 AND collection_name = $2',
                [MARKET_CONTRACT, 'testcol55555']
            );
            expect(result.rowCount).to.equal(1);
        });
    });

    describe('payout ledger', () => {
        async function feedLogroy<T>(name: string, data: T, settlementAction: string, settlementIdField: string, settlementId: string): Promise<void> {
            const settlement = createActionTrace(MARKET_CONTRACT, settlementAction, {[settlementIdField]: settlementId}, {
                action_ordinal: 1, creator_action_ordinal: 0,
            });
            const logTrace = createActionTrace(MARKET_CONTRACT, name, data, {
                action_ordinal: 2, creator_action_ordinal: 1,
            });
            const tx = createTx({traces: [settlement, logTrace]} as any);
            await processActionTrace(processor, db, createBlock(), tx, logTrace);
        }

        it('logroyfound with N payouts produces N rows: category founders, listing_type sale, listing_id = sale_id, correct recipient/amount/symbol per position', async () => {
            const data: LogRoyaltyFoundActionData = {
                collection_name: 'testcol66666',
                asset_id: '1001',
                payouts: [
                    {recipient: 'recipient111', amount: '1.0000 WAX'},
                    {recipient: 'recipient222', amount: '2.5000 WAX'},
                    {recipient: 'recipient333', amount: '0.0001 WAX'},
                ],
            };
            await feedLogroy('logroyfound', data, 'purchasesale', 'sale_id', '700001');

            const result = await client.query(
                'SELECT * FROM atomicmarket_royalty_payouts WHERE market_contract = $1 AND collection_name = $2 ORDER BY payout_index',
                [MARKET_CONTRACT, 'testcol66666']
            );
            expect(result.rowCount).to.equal(3);
            for (let i = 0; i < 3; i++) {
                const row = result.rows[i];
                expect(row.payout_index).to.equal(i);
                expect(row.category).to.equal(RoyaltyPayoutCategory.FOUNDERS.valueOf());
                expect(row.listing_type).to.equal(RoyaltyListingType.SALE.valueOf());
                expect(row.listing_id).to.equal('700001');
                expect(row.asset_id).to.equal('1001');
                expect(row.recipient).to.equal(data.payouts[i].recipient);
                expect(row.token_symbol).to.equal('WAX');
            }
            expect(result.rows[0].amount).to.equal('10000');
            expect(result.rows[1].amount).to.equal('25000');
            expect(result.rows[2].amount).to.equal('1');
        });

        it('logroytempl rows carry template_id and resolve listing linkage', async () => {
            const data: LogRoyaltyTemplateActionData = {
                collection_name: 'testcol77777',
                asset_id: '1002',
                template_id: 55,
                payouts: [{recipient: 'recipient444', amount: '3.0000 WAX'}],
            };
            await feedLogroy('logroytempl', data, 'auctclaimsel', 'auction_id', '700002');

            const result = await client.query(
                'SELECT * FROM atomicmarket_royalty_payouts WHERE market_contract = $1 AND collection_name = $2',
                [MARKET_CONTRACT, 'testcol77777']
            );
            expect(result.rowCount).to.equal(1);
            expect(result.rows[0].category).to.equal(RoyaltyPayoutCategory.TEMPLATE.valueOf());
            expect(result.rows[0].listing_type).to.equal(RoyaltyListingType.AUCTION.valueOf());
            expect(result.rows[0].listing_id).to.equal('700002');
            expect(Number(result.rows[0].template_id)).to.equal(55);
            expect(result.rows[0].rule_id).to.be.null;
        });

        it('logroyattr rows carry rule_id and resolve listing linkage', async () => {
            const data: LogRoyaltyAttributeActionData = {
                collection_name: 'testcol88888',
                asset_id: '1003',
                rule_id: '9',
                payouts: [{recipient: 'recipient555', amount: '4.0000 WAX'}],
            };
            await feedLogroy('logroyattr', data, 'acceptbuyo', 'buyoffer_id', '700003');

            const result = await client.query(
                'SELECT * FROM atomicmarket_royalty_payouts WHERE market_contract = $1 AND collection_name = $2',
                [MARKET_CONTRACT, 'testcol88888']
            );
            expect(result.rowCount).to.equal(1);
            expect(result.rows[0].category).to.equal(RoyaltyPayoutCategory.ATTRIBUTE.valueOf());
            expect(result.rows[0].listing_type).to.equal(RoyaltyListingType.BUYOFFER.valueOf());
            expect(result.rows[0].listing_id).to.equal('700003');
            expect(Number(result.rows[0].rule_id)).to.equal(9);
            expect(result.rows[0].template_id).to.be.null;
        });

        it('logroydust produces one row: category dust, recipient = collection_author, null asset/template/rule', async () => {
            const data: LogRoyaltyDustActionData = {
                collection_name: 'testcol99999',
                collection_author: 'author111111',
                amount: '0.0002 WAX',
            };
            await feedLogroy('logroydust', data, 'fulfilltbuyo', 'buyoffer_id', '700004');

            const result = await client.query(
                'SELECT * FROM atomicmarket_royalty_payouts WHERE market_contract = $1 AND collection_name = $2',
                [MARKET_CONTRACT, 'testcol99999']
            );
            expect(result.rowCount).to.equal(1);
            const row = result.rows[0];
            expect(row.category).to.equal(RoyaltyPayoutCategory.DUST.valueOf());
            expect(row.payout_index).to.equal(0);
            expect(row.recipient).to.equal('author111111');
            expect(row.asset_id).to.be.null;
            expect(row.template_id).to.be.null;
            expect(row.rule_id).to.be.null;
            expect(row.listing_type).to.equal(RoyaltyListingType.TEMPLATE_BUYOFFER.valueOf());
            expect(row.listing_id).to.equal('700004');
        });

        it('passes amounts at the int64 edge through preventInt64Overflow unchanged', async () => {
            const data: LogRoyaltyFoundActionData = {
                collection_name: 'testcolint64',
                asset_id: '1004',
                payouts: [{recipient: 'recipient111', amount: '92233720368.54775807 WAX'}],
            };
            await feedLogroy('logroyfound', data, 'purchasesale', 'sale_id', '700005');

            const result = await client.query(
                'SELECT amount FROM atomicmarket_royalty_payouts WHERE market_contract = $1 AND collection_name = $2',
                [MARKET_CONTRACT, 'testcolint64']
            );
            expect(result.rows[0].amount).to.equal('9223372036854775807');
        });

        it('stores listing_type unresolved (0) with null listing_id when no settlement ancestor resolves, without dropping the payout', async () => {
            const data: LogRoyaltyFoundActionData = {
                collection_name: 'testcolunres',
                asset_id: '1005',
                payouts: [{recipient: 'recipient111', amount: '1.0000 WAX'}],
            };
            // No settlement parent in tx.traces at all.
            const logTrace = createActionTrace(MARKET_CONTRACT, 'logroyfound', data, {
                action_ordinal: 1, creator_action_ordinal: 0,
            });
            const tx = createTx({traces: [logTrace]} as any);
            await processActionTrace(processor, db, createBlock(), tx, logTrace);

            const result = await client.query(
                'SELECT * FROM atomicmarket_royalty_payouts WHERE market_contract = $1 AND collection_name = $2',
                [MARKET_CONTRACT, 'testcolunres']
            );
            expect(result.rowCount).to.equal(1);
            expect(result.rows[0].listing_type).to.equal(RoyaltyListingType.UNRESOLVED.valueOf());
            expect(result.rows[0].listing_id).to.be.null;
        });

        it('processing the same logroy trace twice yields the same single row set (PK idempotency under replay)', async () => {
            const data: LogRoyaltyFoundActionData = {
                collection_name: 'testcolrepl1',
                asset_id: '1006',
                payouts: [
                    {recipient: 'recipient111', amount: '1.0000 WAX'},
                    {recipient: 'recipient222', amount: '2.0000 WAX'},
                ],
            };
            const settlement = createActionTrace(MARKET_CONTRACT, 'purchasesale', {sale_id: '700006'}, {
                action_ordinal: 1, creator_action_ordinal: 0,
            });
            const logTrace = createActionTrace(MARKET_CONTRACT, 'logroyfound', data, {
                action_ordinal: 2, creator_action_ordinal: 1, global_sequence: '123456',
            });
            const tx = createTx({traces: [settlement, logTrace]} as any);

            await processActionTrace(processor, db, createBlock(), tx, logTrace);
            await processActionTrace(processor, db, createBlock(), tx, logTrace);

            const result = await client.query(
                'SELECT * FROM atomicmarket_royalty_payouts WHERE market_contract = $1 AND collection_name = $2',
                [MARKET_CONTRACT, 'testcolrepl1']
            );
            expect(result.rowCount).to.equal(2);
        });

        it('records fork-rollback entries in reversible_queries for payout inserts and config-row deletes in head mode', async () => {
            const headBlockNum = 999888;
            const headDb = createTestTransaction(client, 'test-reader-head', headBlockNum);
            const headProcessor = new DataProcessor(ProcessingState.HEAD, createMockModuleLoader());
            const headDestroy = royaltyProcessor(createMockCore(), headProcessor);

            try {
                // Config insert (not reversed by delete below) plus a config row that gets deleted.
                const confData: RoyaltyConfTableRow = {
                    collection: 'testcolhead1',
                    founders: [],
                    attribute_mode: 0,
                    split_founders: 1000000,
                    split_templates: 0,
                    split_attributes: 0,
                };
                await processContractRow(headProcessor, headDb, createBlock({block_num: headBlockNum}), {
                    code: MARKET_CONTRACT, scope: MARKET_CONTRACT, table: 'royaltyconf',
                    primary_key: '0', payer: MARKET_CONTRACT, present: true, value: confData,
                });
                await processContractRow(headProcessor, headDb, createBlock({block_num: headBlockNum}), {
                    code: MARKET_CONTRACT, scope: MARKET_CONTRACT, table: 'royaltyconf',
                    primary_key: '0', payer: MARKET_CONTRACT, present: false, value: confData,
                });

                const payoutData: LogRoyaltyFoundActionData = {
                    collection_name: 'testcolhead2',
                    asset_id: '2001',
                    payouts: [{recipient: 'recipient111', amount: '1.0000 WAX'}],
                };
                const settlement = createActionTrace(MARKET_CONTRACT, 'purchasesale', {sale_id: '800001'}, {
                    action_ordinal: 1, creator_action_ordinal: 0,
                });
                const logTrace = createActionTrace(MARKET_CONTRACT, 'logroyfound', payoutData, {
                    action_ordinal: 2, creator_action_ordinal: 1,
                });
                const tx = createTx({traces: [settlement, logTrace]} as any);
                await processActionTrace(headProcessor, headDb, createBlock({block_num: headBlockNum}), tx, logTrace);

                const rollbacks = await client.query(
                    'SELECT operation, "table" FROM reversible_queries WHERE block_num = $1 AND reader = $2',
                    [headBlockNum, 'test-reader-head']
                );

                const tables = rollbacks.rows.map(r => r.table);
                expect(tables).to.include('atomicmarket_royalty_payouts');
                // The config row got both an insert (rollback: "delete") and a
                // delete (rollback: "insert", restoring the deleted row) in this
                // test - assert the delete's rollback specifically exists.
                const configDeleteRollback = rollbacks.rows.find(
                    r => r.table === 'atomicmarket_royalties_config' && r.operation === 'insert'
                );
                expect(configDeleteRollback).to.not.be.undefined;
            } finally {
                headDestroy();
            }
        });

        it('with store_logs enabled, each logroy action also lands in contract_traces (in-memory actionLogs) with the resolved listing id merged into metadata', async () => {
            const logsCore = createMockCore({store_logs: true});
            const logsProcessor = new DataProcessor(ProcessingState.HEAD, createMockModuleLoader());
            const logsDb = createTestTransaction(client, 'test-reader-logs');
            const destroyRoyalty = royaltyProcessor(logsCore, logsProcessor);
            const destroyLogs = logProcessor(logsCore, logsProcessor);

            try {
                const data: LogRoyaltyFoundActionData = {
                    collection_name: 'testcollogs1',
                    asset_id: '3001',
                    payouts: [{recipient: 'recipient111', amount: '1.0000 WAX'}],
                };
                const settlement = createActionTrace(MARKET_CONTRACT, 'purchasesale', {sale_id: '800002'}, {
                    action_ordinal: 1, creator_action_ordinal: 0,
                });
                const logTrace = createActionTrace(MARKET_CONTRACT, 'logroyfound', data, {
                    action_ordinal: 2, creator_action_ordinal: 1,
                });
                const tx = createTx({traces: [settlement, logTrace]} as any);
                await processActionTrace(logsProcessor, logsDb, createBlock(), tx, logTrace);

                const entry = logsDb.actionLogs.find(row => row.name === 'logroyfound');
                expect(entry).to.not.be.undefined;
                const metadata = JSON.parse(entry.metadata);
                expect(metadata.collection_name).to.equal('testcollogs1');
                expect(metadata.asset_id).to.equal('3001');
                expect(metadata.sale_id).to.equal('800002');
            } finally {
                destroyRoyalty();
                destroyLogs();
            }
        });
    });
});
