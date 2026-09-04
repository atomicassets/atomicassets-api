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
import { auctionProcessor } from './auctions';
import { AuctionState } from '../index';
import { AuctionBidActionData } from '../types/actions';

const MARKET_CONTRACT = 'atomicmarket';
const ASSETS_CONTRACT = 'atomicassets';

function createMockModuleLoader(): ModuleLoader {
    const loader = Object.create(ModuleLoader.prototype) as ModuleLoader;
    // @ts-ignore
    loader.modules = [];
    // @ts-ignore
    loader.names = [];
    return loader;
}

function createMockCore(version: string): any {
    return {
        args: {
            atomicmarket_account: MARKET_CONTRACT,
            atomicassets_account: ASSETS_CONTRACT,
            delphioracle_account: 'delphioracle',
            store_logs: false,
        },
        config: {version},
        // The flip is behind every block createBlock() hands out, so these tests
        // exercise the asset count rather than the marker. legacy-bundles.test.ts
        // covers the marker itself.
        v2MarkerBlock: 1,
    };
}

/**
 * Answers the auction read the bundle rules perform, plus the bid count the
 * normal bid path needs.
 */
function stubAuction(
    assetCount: number, claimed: {buyer?: boolean, seller?: boolean} = {}
): StubTransaction {
    return createStubTransaction((sql: string) => {
        if (sql.includes('FROM atomicmarket_auctions_bids')) {
            return [{count: '0'}];
        }

        if (sql.includes('FROM atomicmarket_auctions ')) {
            return [{
                claimed_by_buyer: claimed.buyer === true,
                claimed_by_seller: claimed.seller === true,
                asset_count: String(assetCount),
            }];
        }

        return [];
    });
}

async function runAction(
    core: any, stub: StubTransaction, notifier: any, action: string, data: any
): Promise<void> {
    const processor = new DataProcessor(ProcessingState.HEAD, createMockModuleLoader());
    const destroy = auctionProcessor(core, processor, notifier);

    try {
        await processActionTrace(
            processor, stub.db, createBlock(), createTx(),
            createActionTrace(MARKET_CONTRACT, action, data)
        );
    } finally {
        destroy();
    }
}

function bidData(auctionId: string): AuctionBidActionData {
    return {
        bidder: 'bidder111111',
        auction_id: auctionId,
        bid: '15.0000 WAX',
        taker_marketplace: 'taker1111111',
    };
}

describe('auctionProcessor auctionbid on a legacy bundle', () => {
    it('records the bid when the auction holds a single asset', async () => {
        const stub = stubAuction(1);
        const recording = createRecordingNotifier();

        await runAction(createMockCore('2.0.0'), stub, recording.notifier, 'auctionbid', bidData('600101'));

        expect(stub.updates).to.have.lengthOf(1);
        expect(stub.updates[0].values.buyer).to.equal('bidder111111');
        expect(stub.updates[0].values.price).to.equal('150000');
        expect(stub.inserts.map(entry => entry.table)).to.deep.equal(['atomicmarket_auctions_bids']);
        expect(recording.traces.map(entry => entry.channel)).to.deep.equal(['auctions']);
    });

    it('records a bundle on a v2 contract as canceled, with no bid row and no winner', async () => {
        const stub = stubAuction(4);
        const recording = createRecordingNotifier();

        await runAction(createMockCore('2.0.0'), stub, recording.notifier, 'auctionbid', bidData('600102'));

        expect(stub.updates).to.have.lengthOf(1);
        expect(stub.updates[0].table).to.equal('atomicmarket_auctions');
        expect(stub.updates[0].values.state).to.equal(AuctionState.CANCELED.valueOf());
        expect(stub.updates[0].values).to.not.have.property('buyer');
        expect(stub.updates[0].values).to.not.have.property('price');
        expect(stub.inserts).to.be.empty;
        // An auctionbid trace reaches the socket api as new_bid, and no bid stands.
        expect(recording.traces).to.be.empty;
    });

    it('records a bundle bid on a v1 contract, because that contract still takes it', async () => {
        const stub = stubAuction(4);
        const recording = createRecordingNotifier();

        await runAction(createMockCore('1.2.2'), stub, recording.notifier, 'auctionbid', bidData('600103'));

        expect(stub.updates[0].values.buyer).to.equal('bidder111111');
        expect(stub.inserts.map(entry => entry.table)).to.deep.equal(['atomicmarket_auctions_bids']);
        expect(recording.traces.map(entry => entry.channel)).to.deep.equal(['auctions']);
    });
});

describe('auctionProcessor auction claims on a legacy bundle', () => {
    it('records the claim when the auction holds a single asset', async () => {
        const stub = stubAuction(1);
        const recording = createRecordingNotifier();

        await runAction(createMockCore('2.0.0'), stub, recording.notifier, 'auctclaimbuy', {auction_id: '600201'});

        expect(stub.updates).to.have.lengthOf(1);
        expect(stub.updates[0].values.claimed_by_buyer).to.be.true;
        expect(recording.traces).to.be.empty;
    });

    it('records an unclaimed bundle the buyer claims as canceled', async () => {
        const stub = stubAuction(4);
        const recording = createRecordingNotifier();

        await runAction(createMockCore('2.0.0'), stub, recording.notifier, 'auctclaimbuy', {auction_id: '600202'});

        expect(stub.updates).to.have.lengthOf(1);
        expect(stub.updates[0].values.state).to.equal(AuctionState.CANCELED.valueOf());
        expect(stub.updates[0].values).to.not.have.property('claimed_by_buyer');
        // No socket event names either claim action, so this path publishes nothing,
        // the way the normal claim paths publish nothing.
        expect(recording.traces).to.be.empty;
    });

    it('records the normal claim when the seller already claimed the bundle', async () => {
        const stub = stubAuction(4, {seller: true});
        const recording = createRecordingNotifier();

        await runAction(createMockCore('2.0.0'), stub, recording.notifier, 'auctclaimbuy', {auction_id: '600203'});

        expect(stub.updates).to.have.lengthOf(1);
        expect(stub.updates[0].values.claimed_by_buyer).to.be.true;
        expect(stub.updates[0].values).to.not.have.property('state');
    });

    it('records an unclaimed bundle the seller claims as canceled', async () => {
        const stub = stubAuction(4);
        const recording = createRecordingNotifier();

        await runAction(createMockCore('2.0.0'), stub, recording.notifier, 'auctclaimsel', {auction_id: '600204'});

        expect(stub.updates).to.have.lengthOf(1);
        expect(stub.updates[0].values.state).to.equal(AuctionState.CANCELED.valueOf());
        expect(stub.updates[0].values).to.not.have.property('claimed_by_seller');
        expect(recording.traces).to.be.empty;
    });

    it('records the normal claim when the buyer already claimed the bundle', async () => {
        const stub = stubAuction(4, {buyer: true});
        const recording = createRecordingNotifier();

        await runAction(createMockCore('2.0.0'), stub, recording.notifier, 'auctclaimsel', {auction_id: '600205'});

        expect(stub.updates).to.have.lengthOf(1);
        expect(stub.updates[0].values.claimed_by_seller).to.be.true;
        expect(stub.updates[0].values).to.not.have.property('state');
    });

    it('records the claim on a v1 contract without reading the auction', async () => {
        const stub = stubAuction(4);
        const recording = createRecordingNotifier();

        await runAction(createMockCore('1.2.2'), stub, recording.notifier, 'auctclaimsel', {auction_id: '600206'});

        expect(stub.updates[0].values.claimed_by_seller).to.be.true;
        expect(stub.queries).to.be.empty;
    });
});
