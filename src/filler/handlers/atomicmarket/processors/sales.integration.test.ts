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
import { saleProcessor } from './sales';
import DataProcessor, { ProcessingState } from '../../../processor';
import { ContractDBTransaction } from '../../../database';
import { SaleState } from '../index';
import {
    LogNewSaleActionData,
    LogSaleStartActionData,
    CancelSaleActionData,
    PurchaseSaleActionData,
} from '../types/actions';
import { ModuleLoader } from '../../../modules';

const MARKET_CONTRACT = 'atomicmarket';
const ASSETS_CONTRACT = 'atomicassets';

function createMockCore(overrides: Record<string, any> = {}, version?: string): any {
    return {
        args: {
            atomicmarket_account: MARKET_CONTRACT,
            atomicassets_account: ASSETS_CONTRACT,
            delphioracle_account: 'delphioracle',
            store_logs: false,
            ...overrides,
        },
        config: version ? {version} : undefined,
        // The flip is behind every block createBlock() hands out, so a registered
        // version puts these tests under the bundle rules. The marker itself is
        // covered by legacy-bundles.test.ts and processors/config.integration.test.ts.
        v2MarkerBlock: version ? 1 : null,
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

describe('saleProcessor', () => {
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

    // Re-registers the processor against a market contract version. Called
    // without one for the default setup, where the handler has no config and the
    // legacy bundle rules stay dormant.
    function registerProcessor(version?: string): void {
        if (destroyProcessor) {
            destroyProcessor();
        }

        processor = new DataProcessor(ProcessingState.HEAD, createMockModuleLoader());
        db = createTestTransaction(client);
        destroyProcessor = saleProcessor(createMockCore({}, version) as any, processor, createMockNotifier());
    }

    beforeEach(async () => {
        await client.query('BEGIN');
        destroyProcessor = null;
        registerProcessor();
    });

    afterEach(async () => {
        if (destroyProcessor) {
            destroyProcessor();
        }
        await client.query('ROLLBACK');
    });

    // The assets of a sale hang off the AtomicAssets offer it was started with,
    // which is where the legacy bundle rules count them.
    async function createOfferAssetsInDB(offerId: string, assetIds: string[]): Promise<void> {
        for (const [index, assetId] of assetIds.entries()) {
            await client.query(
                'INSERT INTO atomicassets_offers_assets (contract, offer_id, owner, "index", asset_id) VALUES ($1, $2, $3, $4, $5)',
                [ASSETS_CONTRACT, offerId, 'seller111111', index + 1, assetId]
            );
        }
    }

    async function startSaleInDB(saleId: string, offerId: string): Promise<void> {
        const startData: LogSaleStartActionData = {
            sale_id: saleId,
            offer_id: offerId,
        };
        await processActionTrace(
            processor, db, createBlock(), createTx(),
            createActionTrace(MARKET_CONTRACT, 'logsalestart', startData)
        );
    }

    async function createSaleInDB(saleId: string, block?: any): Promise<void> {
        const b = block || createBlock();
        const tx = createTx();
        const data: LogNewSaleActionData = {
            sale_id: saleId,
            seller: 'seller111111',
            asset_ids: ['1001'],
            listing_price: '10.0000 WAX',
            settlement_symbol: '8,WAX',
            maker_marketplace: 'market111111',
            collection_name: 'testcol11111',
            collection_fee: 0.05,
        };
        const trace = createActionTrace(MARKET_CONTRACT, 'lognewsale', data);
        await processActionTrace(processor, db, b, tx, trace);
    }

    describe('lognewsale', () => {
        it('should insert a new sale in WAITING state', async () => {
            const block = createBlock({ timestamp: '2023-05-01T00:00:00.000' });
            const tx = createTx();
            const data: LogNewSaleActionData = {
                sale_id: '500001',
                seller: 'seller111111',
                asset_ids: ['1001', '1002'],
                listing_price: '25.5000 WAX',
                settlement_symbol: '8,WAX',
                maker_marketplace: 'market111111',
                collection_name: 'testcol11111',
                collection_fee: 0.05,
            };
            const trace = createActionTrace(MARKET_CONTRACT, 'lognewsale', data);

            await processActionTrace(processor, db, block, tx, trace);

            const result = await client.query(
                'SELECT * FROM atomicmarket_sales WHERE market_contract = $1 AND sale_id = $2',
                [MARKET_CONTRACT, '500001']
            );
            expect(result.rowCount).to.equal(1);
            const sale = result.rows[0];
            expect(sale.seller).to.equal('seller111111');
            expect(sale.buyer).to.be.null;
            expect(sale.listing_price).to.equal('255000');
            expect(sale.final_price).to.be.null;
            expect(sale.listing_symbol).to.equal('WAX');
            expect(sale.settlement_symbol).to.equal('WAX');
            expect(sale.assets_contract).to.equal(ASSETS_CONTRACT);
            expect(sale.offer_id).to.be.null;
            expect(sale.maker_marketplace).to.equal('market111111');
            expect(sale.taker_marketplace).to.be.null;
            expect(sale.collection_name).to.equal('testcol11111');
            expect(parseFloat(sale.collection_fee)).to.equal(0.05);
            expect(sale.state).to.equal(SaleState.WAITING.valueOf());
            expect(Number(sale.created_at_block)).to.equal(block.block_num);
        });
    });

    describe('logsalestart', () => {
        it('should update sale state to LISTED and set offer_id', async () => {
            await createSaleInDB('500002');

            const startBlock = createBlock();
            const startTx = createTx();
            const startData: LogSaleStartActionData = {
                sale_id: '500002',
                offer_id: '999001',
            };
            const startTrace = createActionTrace(MARKET_CONTRACT, 'logsalestart', startData);
            await processActionTrace(processor, db, startBlock, startTx, startTrace);

            const result = await client.query(
                'SELECT state, offer_id, updated_at_block FROM atomicmarket_sales WHERE market_contract = $1 AND sale_id = $2',
                [MARKET_CONTRACT, '500002']
            );
            expect(result.rows[0].state).to.equal(SaleState.LISTED.valueOf());
            expect(result.rows[0].offer_id).to.equal('999001');
            expect(Number(result.rows[0].updated_at_block)).to.equal(startBlock.block_num);
        });
    });

    describe('cancelsale', () => {
        it('should update sale state to CANCELED', async () => {
            await createSaleInDB('500003');

            const cancelBlock = createBlock();
            const cancelTx = createTx();
            const cancelData: CancelSaleActionData = {
                sale_id: '500003',
            };
            const cancelTrace = createActionTrace(MARKET_CONTRACT, 'cancelsale', cancelData);
            await processActionTrace(processor, db, cancelBlock, cancelTx, cancelTrace);

            const result = await client.query(
                'SELECT state FROM atomicmarket_sales WHERE market_contract = $1 AND sale_id = $2',
                [MARKET_CONTRACT, '500003']
            );
            expect(result.rows[0].state).to.equal(SaleState.CANCELED.valueOf());
        });
    });

    describe('purchasesale', () => {
        it('should update sale to SOLD with final_price when intended_delphi_median is 0', async () => {
            await createSaleInDB('500004');

            const purchaseBlock = createBlock();
            const purchaseTx = createTx();
            const purchaseData: PurchaseSaleActionData = {
                buyer: 'buyer1111111',
                sale_id: '500004',
                intended_delphi_median: '0',
                taker_marketplace: 'taker1111111',
            };
            const purchaseTrace = createActionTrace(MARKET_CONTRACT, 'purchasesale', purchaseData);
            await processActionTrace(processor, db, purchaseBlock, purchaseTx, purchaseTrace);

            const result = await client.query(
                'SELECT * FROM atomicmarket_sales WHERE market_contract = $1 AND sale_id = $2',
                [MARKET_CONTRACT, '500004']
            );
            const sale = result.rows[0];
            expect(sale.state).to.equal(SaleState.SOLD.valueOf());
            expect(sale.buyer).to.equal('buyer1111111');
            expect(sale.taker_marketplace).to.equal('taker1111111');
            // When delphi median is 0, final_price equals listing_price
            expect(sale.final_price).to.equal(sale.listing_price);
            expect(Number(sale.updated_at_block)).to.equal(purchaseBlock.block_num);
        });

        it('should not overwrite an already-SOLD sale on replay', async () => {
            await createSaleInDB('500005');

            const firstBlock = createBlock();
            const firstTrace = createActionTrace(MARKET_CONTRACT, 'purchasesale', {
                buyer: 'buyer1111111',
                sale_id: '500005',
                intended_delphi_median: '0',
                taker_marketplace: 'taker1111111',
            } as PurchaseSaleActionData);
            await processActionTrace(processor, db, firstBlock, createTx(), firstTrace);

            const afterFirst = await client.query(
                'SELECT * FROM atomicmarket_sales WHERE market_contract = $1 AND sale_id = $2',
                [MARKET_CONTRACT, '500005']
            );
            const initialRow = afterFirst.rows[0];
            expect(initialRow.state).to.equal(SaleState.SOLD.valueOf());

            // Replay with different buyer/marketplace - guard should ignore the second event entirely.
            const replayBlock = createBlock();
            const replayTrace = createActionTrace(MARKET_CONTRACT, 'purchasesale', {
                buyer: 'attacker1111',
                sale_id: '500005',
                intended_delphi_median: '0',
                taker_marketplace: 'taker2222222',
            } as PurchaseSaleActionData);
            await processActionTrace(processor, db, replayBlock, createTx(), replayTrace);

            const afterReplay = await client.query(
                'SELECT * FROM atomicmarket_sales WHERE market_contract = $1 AND sale_id = $2',
                [MARKET_CONTRACT, '500005']
            );
            const replayedRow = afterReplay.rows[0];
            expect(replayedRow.buyer).to.equal('buyer1111111');
            expect(replayedRow.taker_marketplace).to.equal('taker1111111');
            // final_price is the actual corruption vector this guard prevents - assert
            // it stayed identical to the value computed during initial processing.
            expect(replayedRow.final_price).to.equal(initialRow.final_price);
            expect(Number(replayedRow.updated_at_block)).to.equal(Number(initialRow.updated_at_block));
            expect(Number(replayedRow.updated_at_time)).to.equal(Number(initialRow.updated_at_time));
        });
    });

    describe('purchasesale on a legacy bundle', () => {
        async function purchase(saleId: string): Promise<any> {
            const purchaseData: PurchaseSaleActionData = {
                buyer: 'buyer1111111',
                sale_id: saleId,
                intended_delphi_median: '0',
                taker_marketplace: 'taker1111111',
            };
            await processActionTrace(
                processor, db, createBlock(), createTx(),
                createActionTrace(MARKET_CONTRACT, 'purchasesale', purchaseData)
            );

            const result = await client.query(
                'SELECT * FROM atomicmarket_sales WHERE market_contract = $1 AND sale_id = $2',
                [MARKET_CONTRACT, saleId]
            );

            return result.rows[0];
        }

        it('records a bundle on a v2 contract as canceled, with no buyer and no final price', async () => {
            registerProcessor('2.0.0');
            await createSaleInDB('500006');
            await startSaleInDB('500006', '999006');
            await createOfferAssetsInDB('999006', ['1001', '1002', '1003']);

            const sale = await purchase('500006');

            expect(sale.state).to.equal(SaleState.CANCELED.valueOf());
            expect(sale.buyer).to.be.null;
            expect(sale.final_price).to.be.null;
            expect(sale.taker_marketplace).to.be.null;
        });

        it('records a single-asset sale on a v2 contract as sold', async () => {
            registerProcessor('2.0.0');
            await createSaleInDB('500007');
            await startSaleInDB('500007', '999007');
            await createOfferAssetsInDB('999007', ['1001']);

            const sale = await purchase('500007');

            expect(sale.state).to.equal(SaleState.SOLD.valueOf());
            expect(sale.buyer).to.equal('buyer1111111');
            expect(sale.final_price).to.equal(sale.listing_price);
        });

        it('records a sale that has no offer as canceled, because only the bundle branch reaches it', async () => {
            registerProcessor('2.0.0');
            await createSaleInDB('500009');

            const sale = await purchase('500009');

            expect(sale.state).to.equal(SaleState.CANCELED.valueOf());
            expect(sale.buyer).to.be.null;
            expect(sale.final_price).to.be.null;
        });

        it('records a bundle on a v1 contract as sold, because that contract still settles it', async () => {
            registerProcessor('1.2.2');
            await createSaleInDB('500008');
            await startSaleInDB('500008', '999008');
            await createOfferAssetsInDB('999008', ['1001', '1002', '1003']);

            const sale = await purchase('500008');

            expect(sale.state).to.equal(SaleState.SOLD.valueOf());
            expect(sale.buyer).to.equal('buyer1111111');
        });
    });
});
