import 'mocha';
import { expect } from 'chai';

import {
    createActionTrace,
    createBlock,
    createRecordingNotifier,
    createStubTransaction,
    createTx,
    processActionTrace,
    StubTransaction,
} from '../../test-helper';
import DataProcessor, { ProcessingState } from '../../../processor';
import { ModuleLoader } from '../../../modules';
import { saleProcessor } from './sales';
import { SaleState } from '../index';
import { PurchaseSaleActionData } from '../types/actions';

const MARKET_CONTRACT = 'atomicmarket';
const ASSETS_CONTRACT = 'atomicassets';
const OFFER_ID = '999001';
const LISTING_PRICE = '100000';

function createMockModuleLoader(): ModuleLoader {
    const loader = Object.create(ModuleLoader.prototype) as ModuleLoader;
    // @ts-ignore
    loader.modules = [];
    // @ts-ignore
    loader.names = [];
    return loader;
}

function createMockCore(version: string | null, overrides: Record<string, any> = {}): any {
    return {
        args: {
            atomicmarket_account: MARKET_CONTRACT,
            atomicassets_account: ASSETS_CONTRACT,
            delphioracle_account: 'delphioracle',
            store_logs: false,
        },
        config: version === null ? undefined : {version},
        // The flip is behind every block createBlock() hands out, so these tests
        // exercise the asset count rather than the marker. legacy-bundles.test.ts
        // covers the marker itself.
        v2MarkerBlock: 1,
        ...overrides,
    };
}

/**
 * Answers the two reads purchasesale performs: the sale row, then the asset
 * count behind its offer. `offerId` null stands for a sale whose offer the
 * seller has not created yet.
 */
function stubSale(assetCount: number, offerId: string | null = OFFER_ID): StubTransaction {
    return createStubTransaction((sql: string) => {
        if (sql.includes('FROM atomicmarket_sales')) {
            return [{
                state: SaleState.LISTED.valueOf(),
                listing_price: LISTING_PRICE,
                offer_id: offerId,
                assets_contract: ASSETS_CONTRACT,
            }];
        }

        if (sql.includes('FROM atomicassets_offers_assets')) {
            return [{count: String(assetCount)}];
        }

        return [];
    });
}

async function purchase(core: any, stub: StubTransaction, notifier: any, saleId: string): Promise<void> {
    const processor = new DataProcessor(ProcessingState.HEAD, createMockModuleLoader());
    const destroy = saleProcessor(core, processor, notifier);

    try {
        const data: PurchaseSaleActionData = {
            buyer: 'buyer1111111',
            sale_id: saleId,
            intended_delphi_median: '0',
            taker_marketplace: 'taker1111111',
        };

        await processActionTrace(
            processor, stub.db, createBlock(), createTx(),
            createActionTrace(MARKET_CONTRACT, 'purchasesale', data)
        );
    } finally {
        destroy();
    }
}

describe('saleProcessor purchasesale on a legacy bundle', () => {
    it('records the sale as sold when it holds a single asset', async () => {
        const stub = stubSale(1);
        const recording = createRecordingNotifier();

        await purchase(createMockCore('2.0.0'), stub, recording.notifier, '500101');

        expect(stub.updates).to.have.lengthOf(1);
        expect(stub.updates[0].table).to.equal('atomicmarket_sales');
        expect(stub.updates[0].values.state).to.equal(SaleState.SOLD.valueOf());
        expect(stub.updates[0].values.buyer).to.equal('buyer1111111');
        expect(stub.updates[0].values.final_price).to.equal(LISTING_PRICE);
        expect(recording.traces.map(entry => entry.channel)).to.deep.equal(['sales']);
    });

    it('records a bundle on a v2 contract as canceled, with no buyer and no final price', async () => {
        const stub = stubSale(3);
        const recording = createRecordingNotifier();

        await purchase(createMockCore('2.0.0'), stub, recording.notifier, '500102');

        expect(stub.updates).to.have.lengthOf(1);
        expect(stub.updates[0].table).to.equal('atomicmarket_sales');
        expect(stub.updates[0].values.state).to.equal(SaleState.CANCELED.valueOf());
        expect(stub.updates[0].values).to.not.have.property('buyer');
        expect(stub.updates[0].values).to.not.have.property('final_price');
        expect(stub.updates[0].values).to.not.have.property('taker_marketplace');
        // A purchasesale trace reaches the socket api as purchased_sale, and no
        // sale settled here.
        expect(recording.traces).to.be.empty;
    });

    it('records a bundle on a v1 contract as sold, because that contract still settles it', async () => {
        const stub = stubSale(3);
        const recording = createRecordingNotifier();

        await purchase(createMockCore('1.2.2'), stub, recording.notifier, '500103');

        expect(stub.updates[0].values.state).to.equal(SaleState.SOLD.valueOf());
        expect(stub.updates[0].values.buyer).to.equal('buyer1111111');
        // The version rules the asset count out before it is read.
        expect(stub.queries.filter(entry => entry.sql.includes('atomicassets_offers_assets'))).to.be.empty;
        expect(recording.traces.map(entry => entry.channel)).to.deep.equal(['sales']);
    });

    it('records the old outcome when the handler has no contract version yet', async () => {
        const stub = stubSale(3);
        const recording = createRecordingNotifier();

        await purchase(createMockCore(null), stub, recording.notifier, '500104');

        expect(stub.updates[0].values.state).to.equal(SaleState.SOLD.valueOf());
    });

    it('records a sale that has no offer as canceled, because only the bundle branch reaches it', async () => {
        const stub = stubSale(1, null);
        const recording = createRecordingNotifier();

        await purchase(createMockCore('2.0.0'), stub, recording.notifier, '500105');

        expect(stub.updates).to.have.lengthOf(1);
        expect(stub.updates[0].values.state).to.equal(SaleState.CANCELED.valueOf());
        expect(stub.updates[0].values).to.not.have.property('buyer');
        // No offer means no asset list to count, and none is read.
        expect(stub.queries.filter(entry => entry.sql.includes('atomicassets_offers_assets'))).to.be.empty;
        expect(recording.traces).to.be.empty;
    });

    it('records the old outcome for a sale that has no offer on a v1 contract', async () => {
        const stub = stubSale(1, null);
        const recording = createRecordingNotifier();

        await purchase(createMockCore('1.2.2'), stub, recording.notifier, '500106');

        expect(stub.updates[0].values.state).to.equal(SaleState.SOLD.valueOf());
    });
});
