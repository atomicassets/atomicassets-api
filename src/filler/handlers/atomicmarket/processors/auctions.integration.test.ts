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
import { auctionProcessor } from './auctions';
import DataProcessor, { ProcessingState } from '../../../processor';
import { ContractDBTransaction } from '../../../database';
import { AuctionState } from '../index';
import {
    LogNewAuctionActionData,
    LogAuctionStartActionData,
    CancelAuctionActionData,
    AuctionBidActionData,
    AuctionClaimBuyerActionData,
    AuctionClaimSellerActionData,
} from '../types/actions';
import { AuctionsTableRow } from '../types/tables';
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

describe('auctionProcessor', () => {
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
        destroyProcessor = auctionProcessor(core as any, processor, notifier);
    });

    afterEach(async () => {
        if (destroyProcessor) {
            destroyProcessor();
        }
        await client.query('ROLLBACK');
    });

    async function createAuctionInDB(auctionId: string, block?: any): Promise<void> {
        const b = block || createBlock();
        const tx = createTx();
        const data: LogNewAuctionActionData = {
            auction_id: auctionId,
            seller: 'seller111111',
            asset_ids: ['1001', '1002'],
            starting_bid: '5.0000 WAX',
            duration: 86400,
            end_time: Math.floor(Date.now() / 1000) + 86400,
            maker_marketplace: 'market111111',
            collection_name: 'testcol11111',
            collection_fee: 0.05,
        };
        const trace = createActionTrace(MARKET_CONTRACT, 'lognewauct', data);
        await processActionTrace(processor, db, b, tx, trace);
    }

    describe('lognewauct', () => {
        it('should insert a new auction in WAITING state with assets', async () => {
            const block = createBlock({ timestamp: '2023-06-01T00:00:00.000' });
            const tx = createTx();
            const endTime = Math.floor(Date.now() / 1000) + 86400;
            const data: LogNewAuctionActionData = {
                auction_id: '700001',
                seller: 'seller111111',
                asset_ids: ['1001', '1002'],
                starting_bid: '10.0000 WAX',
                duration: 86400,
                end_time: endTime,
                maker_marketplace: 'market111111',
                collection_name: 'testcol11111',
                collection_fee: 0.05,
            };
            const trace = createActionTrace(MARKET_CONTRACT, 'lognewauct', data);

            await processActionTrace(processor, db, block, tx, trace);

            // Check auction record
            const auctionResult = await client.query(
                'SELECT * FROM atomicmarket_auctions WHERE market_contract = $1 AND auction_id = $2',
                [MARKET_CONTRACT, '700001']
            );
            expect(auctionResult.rowCount).to.equal(1);
            const auction = auctionResult.rows[0];
            expect(auction.seller).to.equal('seller111111');
            expect(auction.buyer).to.be.null;
            expect(auction.price).to.equal('100000');
            expect(auction.token_symbol).to.equal('WAX');
            expect(auction.assets_contract).to.equal(ASSETS_CONTRACT);
            expect(auction.maker_marketplace).to.equal('market111111');
            expect(auction.taker_marketplace).to.be.null;
            expect(auction.collection_name).to.equal('testcol11111');
            expect(parseFloat(auction.collection_fee)).to.equal(0.05);
            expect(auction.claimed_by_buyer).to.equal(false);
            expect(auction.claimed_by_seller).to.equal(false);
            expect(auction.state).to.equal(AuctionState.WAITING.valueOf());
            expect(Number(auction.end_time)).to.equal(endTime);

            // Check auction assets
            const assetsResult = await client.query(
                'SELECT * FROM atomicmarket_auctions_assets WHERE market_contract = $1 AND auction_id = $2 ORDER BY index',
                [MARKET_CONTRACT, '700001']
            );
            expect(assetsResult.rowCount).to.equal(2);
            expect(assetsResult.rows[0].asset_id).to.equal('1001');
            expect(assetsResult.rows[0].index).to.equal(1);
            expect(assetsResult.rows[1].asset_id).to.equal('1002');
            expect(assetsResult.rows[1].index).to.equal(2);
            expect(assetsResult.rows[0].assets_contract).to.equal(ASSETS_CONTRACT);
        });
    });

    describe('logauctstart', () => {
        it('should update auction state to LISTED', async () => {
            await createAuctionInDB('700002');

            const startBlock = createBlock();
            const startTx = createTx();
            const startData: LogAuctionStartActionData = {
                auction_id: '700002',
            };
            const startTrace = createActionTrace(MARKET_CONTRACT, 'logauctstart', startData);
            await processActionTrace(processor, db, startBlock, startTx, startTrace);

            const result = await client.query(
                'SELECT state, updated_at_block FROM atomicmarket_auctions WHERE market_contract = $1 AND auction_id = $2',
                [MARKET_CONTRACT, '700002']
            );
            expect(result.rows[0].state).to.equal(AuctionState.LISTED.valueOf());
            expect(Number(result.rows[0].updated_at_block)).to.equal(startBlock.block_num);
        });
    });

    describe('cancelauct', () => {
        it('should update auction state to CANCELED', async () => {
            await createAuctionInDB('700003');

            const cancelBlock = createBlock();
            const cancelTx = createTx();
            const cancelData: CancelAuctionActionData = {
                auction_id: '700003',
            };
            const cancelTrace = createActionTrace(MARKET_CONTRACT, 'cancelauct', cancelData);
            await processActionTrace(processor, db, cancelBlock, cancelTx, cancelTrace);

            const result = await client.query(
                'SELECT state FROM atomicmarket_auctions WHERE market_contract = $1 AND auction_id = $2',
                [MARKET_CONTRACT, '700003']
            );
            expect(result.rows[0].state).to.equal(AuctionState.CANCELED.valueOf());
        });
    });

    describe('auctionbid', () => {
        it('should update auction buyer and price, and insert a bid record', async () => {
            await createAuctionInDB('700004');

            const bidBlock = createBlock();
            const bidTx = createTx();
            const bidData: AuctionBidActionData = {
                bidder: 'bidder111111',
                auction_id: '700004',
                bid: '15.0000 WAX',
                taker_marketplace: 'taker1111111',
            };
            const bidTrace = createActionTrace(MARKET_CONTRACT, 'auctionbid', bidData);
            await processActionTrace(processor, db, bidBlock, bidTx, bidTrace);

            // Check auction updated
            const auctionResult = await client.query(
                'SELECT buyer, price, token_symbol, taker_marketplace FROM atomicmarket_auctions WHERE market_contract = $1 AND auction_id = $2',
                [MARKET_CONTRACT, '700004']
            );
            const auction = auctionResult.rows[0];
            expect(auction.buyer).to.equal('bidder111111');
            expect(auction.price).to.equal('150000');
            expect(auction.token_symbol).to.equal('WAX');
            expect(auction.taker_marketplace).to.equal('taker1111111');

            // Check bid record
            const bidResult = await client.query(
                'SELECT * FROM atomicmarket_auctions_bids WHERE market_contract = $1 AND auction_id = $2',
                [MARKET_CONTRACT, '700004']
            );
            expect(bidResult.rowCount).to.equal(1);
            expect(bidResult.rows[0].bid_number).to.equal(1);
            expect(bidResult.rows[0].account).to.equal('bidder111111');
            expect(bidResult.rows[0].amount).to.equal('150000');
        });

        it('should increment bid_number for successive bids', async () => {
            await createAuctionInDB('700005');

            // First bid
            const bid1Block = createBlock();
            const bid1Tx = createTx();
            const bid1Data: AuctionBidActionData = {
                bidder: 'bidder111111',
                auction_id: '700005',
                bid: '10.0000 WAX',
                taker_marketplace: 'taker1111111',
            };
            const bid1Trace = createActionTrace(MARKET_CONTRACT, 'auctionbid', bid1Data);
            await processActionTrace(processor, db, bid1Block, bid1Tx, bid1Trace);

            // Second bid
            const bid2Block = createBlock();
            const bid2Tx = createTx();
            const bid2Data: AuctionBidActionData = {
                bidder: 'bidder222222',
                auction_id: '700005',
                bid: '20.0000 WAX',
                taker_marketplace: 'taker2222222',
            };
            const bid2Trace = createActionTrace(MARKET_CONTRACT, 'auctionbid', bid2Data);
            await processActionTrace(processor, db, bid2Block, bid2Tx, bid2Trace);

            const bidResult = await client.query(
                'SELECT * FROM atomicmarket_auctions_bids WHERE market_contract = $1 AND auction_id = $2 ORDER BY bid_number',
                [MARKET_CONTRACT, '700005']
            );
            expect(bidResult.rowCount).to.equal(2);
            expect(bidResult.rows[0].bid_number).to.equal(1);
            expect(bidResult.rows[0].account).to.equal('bidder111111');
            expect(bidResult.rows[1].bid_number).to.equal(2);
            expect(bidResult.rows[1].account).to.equal('bidder222222');

            // Auction should reflect latest bid
            const auctionResult = await client.query(
                'SELECT buyer, price FROM atomicmarket_auctions WHERE market_contract = $1 AND auction_id = $2',
                [MARKET_CONTRACT, '700005']
            );
            expect(auctionResult.rows[0].buyer).to.equal('bidder222222');
            expect(auctionResult.rows[0].price).to.equal('200000');
        });
    });

    describe('auctclaimbuy', () => {
        it('should set claimed_by_buyer to true', async () => {
            await createAuctionInDB('700006');

            const claimBlock = createBlock();
            const claimTx = createTx();
            const claimData: AuctionClaimBuyerActionData = {
                auction_id: '700006',
            };
            const claimTrace = createActionTrace(MARKET_CONTRACT, 'auctclaimbuy', claimData);
            await processActionTrace(processor, db, claimBlock, claimTx, claimTrace);

            const result = await client.query(
                'SELECT claimed_by_buyer, updated_at_block FROM atomicmarket_auctions WHERE market_contract = $1 AND auction_id = $2',
                [MARKET_CONTRACT, '700006']
            );
            expect(result.rows[0].claimed_by_buyer).to.equal(true);
            expect(Number(result.rows[0].updated_at_block)).to.equal(claimBlock.block_num);
        });
    });

    describe('auctclaimsel', () => {
        it('should set claimed_by_seller to true', async () => {
            await createAuctionInDB('700007');

            const claimBlock = createBlock();
            const claimTx = createTx();
            const claimData: AuctionClaimSellerActionData = {
                auction_id: '700007',
            };
            const claimTrace = createActionTrace(MARKET_CONTRACT, 'auctclaimsel', claimData);
            await processActionTrace(processor, db, claimBlock, claimTx, claimTrace);

            const result = await client.query(
                'SELECT claimed_by_seller, updated_at_block FROM atomicmarket_auctions WHERE market_contract = $1 AND auction_id = $2',
                [MARKET_CONTRACT, '700007']
            );
            expect(result.rows[0].claimed_by_seller).to.equal(true);
            expect(Number(result.rows[0].updated_at_block)).to.equal(claimBlock.block_num);
        });
    });

    describe('auctions table delta', () => {
        it('should update end_time from contract row delta', async () => {
            await createAuctionInDB('700008');

            const deltaBlock = createBlock();
            const newEndTime = Math.floor(Date.now() / 1000) + 172800;
            const deltaValue: AuctionsTableRow = {
                auction_id: '700008',
                seller: 'seller111111',
                asset_ids: ['1001', '1002'],
                end_time: newEndTime,
                assets_transferred: true,
                current_bid: '10.0000 WAX',
                current_bidder: 'bidder111111',
                claimed_by_seller: false,
                claimed_by_buyer: false,
                maker_marketplace: 'market111111',
                taker_marketplace: '',
                collection_fee: 0.05,
                collection_name: 'testcol11111',
            };

            const delta = createContractRow(MARKET_CONTRACT, 'auctions', deltaValue, true);
            await processContractRow(processor, db, deltaBlock, delta);

            const result = await client.query(
                'SELECT end_time, updated_at_block FROM atomicmarket_auctions WHERE market_contract = $1 AND auction_id = $2',
                [MARKET_CONTRACT, '700008']
            );
            expect(Number(result.rows[0].end_time)).to.equal(newEndTime);
            expect(Number(result.rows[0].updated_at_block)).to.equal(deltaBlock.block_num);
        });
    });
});
