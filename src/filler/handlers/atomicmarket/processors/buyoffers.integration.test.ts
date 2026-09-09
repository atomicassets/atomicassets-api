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
import { buyofferProcessor } from './buyoffers';
import DataProcessor, { ProcessingState } from '../../../processor';
import { ContractDBTransaction } from '../../../database';
import { BuyofferState } from '../index';
import {
    AcceptBuyofferActionData,
    DeclineBuyofferActionData,
    LogNewBuyofferActionData,
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

describe('buyofferProcessor', () => {
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
        destroyProcessor = buyofferProcessor(createMockCore({}, version) as any, processor, createMockNotifier());
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

    async function createBuyofferInDB(buyofferId: string, assetIds: string[]): Promise<void> {
        const data: LogNewBuyofferActionData = {
            buyoffer_id: buyofferId,
            buyer: 'buyer1111111',
            recipient: 'seller111111',
            price: '12.0000 WAX',
            asset_ids: assetIds,
            memo: 'take it',
            maker_marketplace: 'market111111',
            collection_name: 'testcol11111',
            collection_fee: 0.05,
        };
        await processActionTrace(
            processor, db, createBlock(), createTx(),
            createActionTrace(MARKET_CONTRACT, 'lognewbuyo', data)
        );
    }

    async function readBuyoffer(buyofferId: string): Promise<any> {
        const result = await client.query(
            'SELECT * FROM atomicmarket_buyoffers WHERE market_contract = $1 AND buyoffer_id = $2',
            [MARKET_CONTRACT, buyofferId]
        );

        return result.rows[0];
    }

    async function accept(buyofferId: string, assetIds: string[]): Promise<any> {
        const data: AcceptBuyofferActionData = {
            buyoffer_id: buyofferId,
            expected_asset_ids: assetIds,
            expected_price: '12.0000 WAX',
            taker_marketplace: 'taker1111111',
        };
        await processActionTrace(
            processor, db, createBlock(), createTx(),
            createActionTrace(MARKET_CONTRACT, 'acceptbuyo', data)
        );

        return readBuyoffer(buyofferId);
    }

    describe('acceptbuyo', () => {
        it('should update the buyoffer to ACCEPTED with the taker marketplace', async () => {
            await createBuyofferInDB('800001', ['1001']);

            const buyoffer = await accept('800001', ['1001']);

            expect(buyoffer.state).to.equal(BuyofferState.ACCEPTED.valueOf());
            expect(buyoffer.taker_marketplace).to.equal('taker1111111');
            expect(buyoffer.decline_memo).to.be.null;
        });
    });

    describe('declinebuyo', () => {
        it('should update the buyoffer to DECLINED and keep the decline memo', async () => {
            await createBuyofferInDB('800002', ['1001']);

            const declineData: DeclineBuyofferActionData = {
                buyoffer_id: '800002',
                decline_memo: 'not for sale',
            };
            await processActionTrace(
                processor, db, createBlock(), createTx(),
                createActionTrace(MARKET_CONTRACT, 'declinebuyo', declineData)
            );

            const buyoffer = await readBuyoffer('800002');
            expect(buyoffer.state).to.equal(BuyofferState.DECLINED.valueOf());
            expect(buyoffer.decline_memo).to.equal('not for sale');
        });
    });

    describe('acceptbuyo on a legacy bundle', () => {
        it('records a bundle on a v2 contract as declined, with an empty memo and no taker marketplace', async () => {
            registerProcessor('2.0.0');
            await createBuyofferInDB('800003', ['1001', '1002']);

            const buyoffer = await accept('800003', ['1001', '1002']);

            expect(buyoffer.state).to.equal(BuyofferState.DECLINED.valueOf());
            expect(buyoffer.decline_memo).to.equal('');
            expect(buyoffer.taker_marketplace).to.be.null;
        });

        it('records a single-asset buyoffer on a v2 contract as accepted', async () => {
            registerProcessor('2.0.0');
            await createBuyofferInDB('800004', ['1001']);

            const buyoffer = await accept('800004', ['1001']);

            expect(buyoffer.state).to.equal(BuyofferState.ACCEPTED.valueOf());
            expect(buyoffer.taker_marketplace).to.equal('taker1111111');
        });

        it('leaves a settled bundle purchase alone when the reader replays the accept', async () => {
            // The buyoffer settled while the chain was still on v1, and the reader rewinds
            // over that block after the upgrade. Rewriting it would erase a real purchase.
            registerProcessor('1.2.2');
            await createBuyofferInDB('800006', ['1001', '1002']);
            const accepted = await accept('800006', ['1001', '1002']);
            expect(accepted.state).to.equal(BuyofferState.ACCEPTED.valueOf());

            registerProcessor('2.0.0');
            const replayed = await accept('800006', ['1001', '1002']);

            expect(replayed.state).to.equal(BuyofferState.ACCEPTED.valueOf());
            expect(replayed.taker_marketplace).to.equal('taker1111111');
            expect(replayed.decline_memo).to.be.null;
            expect(Number(replayed.updated_at_block)).to.equal(Number(accepted.updated_at_block));
        });

        it('records a bundle on a v1 contract as accepted, because that contract still settles it', async () => {
            registerProcessor('1.2.2');
            await createBuyofferInDB('800005', ['1001', '1002']);

            const buyoffer = await accept('800005', ['1001', '1002']);

            expect(buyoffer.state).to.equal(BuyofferState.ACCEPTED.valueOf());
            expect(buyoffer.taker_marketplace).to.equal('taker1111111');
        });
    });
});
