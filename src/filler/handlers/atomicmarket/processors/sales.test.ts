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

    beforeEach(async () => {
        await client.query('BEGIN');
        processor = new DataProcessor(ProcessingState.HEAD, createMockModuleLoader());
        db = createTestTransaction(client);
        const core = createMockCore();
        const notifier = createMockNotifier();
        destroyProcessor = saleProcessor(core as any, processor, notifier);
    });

    afterEach(async () => {
        if (destroyProcessor) {
            destroyProcessor();
        }
        await client.query('ROLLBACK');
    });

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

            // Replay with different buyer/marketplace — guard should ignore the second event entirely.
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
            expect(Number(replayedRow.updated_at_block)).to.equal(Number(initialRow.updated_at_block));
        });
    });
});
