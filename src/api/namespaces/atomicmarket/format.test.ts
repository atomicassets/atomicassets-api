import 'mocha';
import { expect } from 'chai';

import { formatAuction } from './format';
import { AuctionApiState } from './index';
import { AuctionState } from '../../../filler/handlers/atomicmarket';

const ENDED = Math.floor(Date.now() / 1000) - 3600;
const OPEN = Math.floor(Date.now() / 1000) + 3600;

function auctionRow(overrides: Record<string, any> = {}): any {
    return {
        auction_state: AuctionState.LISTED.valueOf(),
        end_time: ENDED,
        buyer: 'bidder111111',
        assets: ['1001'],
        claimed_by_buyer: false,
        claimed_by_seller: false,
        raw_price: '100000',
        raw_token_symbol: 'WAX',
        raw_token_precision: 8,
        collection_name: 'testcol11111',
        price: {},
        ...overrides,
    };
}

describe('formatAuction legacy bundle state', () => {
    it('reports an ended single-asset auction with a bid as sold', () => {
        expect(formatAuction(auctionRow(), true).state).to.equal(AuctionApiState.SOLD.valueOf());
    });

    it('reports an ended bundle auction with a bid as invalid on a v2 contract', () => {
        // Whichever side claims it, the contract refunds the bid and returns the
        // assets, so it never settles and is not sold.
        const row = auctionRow({assets: ['1001', '1002']});

        expect(formatAuction(row, true).state).to.equal(AuctionApiState.INVALID.valueOf());
    });

    it('reports an ended bundle auction with a bid as sold on a v1 contract', () => {
        const row = auctionRow({assets: ['1001', '1002']});

        expect(formatAuction(row, false).state).to.equal(AuctionApiState.SOLD.valueOf());
    });

    it('keeps the old state for a caller that passes no contract version', () => {
        const row = auctionRow({assets: ['1001', '1002']});

        expect(formatAuction(row).state).to.equal(AuctionApiState.SOLD.valueOf());
    });

    it('leaves an open bundle auction listed on a v2 contract', () => {
        const row = auctionRow({assets: ['1001', '1002'], end_time: OPEN});

        expect(formatAuction(row, true).state).to.equal(AuctionApiState.LISTED.valueOf());
    });

    it('leaves a canceled bundle auction canceled on a v2 contract', () => {
        const row = auctionRow({assets: ['1001', '1002'], auction_state: AuctionState.CANCELED.valueOf()});

        expect(formatAuction(row, true).state).to.equal(AuctionApiState.CANCELED.valueOf());
    });

    it('reports a partially claimed ended bundle auction as sold, because it still settles', () => {
        // One side was already served, so the contract finishes it through the
        // normal claim path and the remaining claim pays the collection fee.
        const claimedByBuyer = auctionRow({assets: ['1001', '1002'], claimed_by_buyer: true});
        const claimedBySeller = auctionRow({assets: ['1001', '1002'], claimed_by_seller: true});

        expect(formatAuction(claimedByBuyer, true).state).to.equal(AuctionApiState.SOLD.valueOf());
        expect(formatAuction(claimedBySeller, true).state).to.equal(AuctionApiState.SOLD.valueOf());
    });

    it('reports an ended bundle auction with no bid as invalid, as it always did', () => {
        const row = auctionRow({assets: ['1001', '1002'], buyer: null});

        expect(formatAuction(row, true).state).to.equal(AuctionApiState.INVALID.valueOf());
    });
});
