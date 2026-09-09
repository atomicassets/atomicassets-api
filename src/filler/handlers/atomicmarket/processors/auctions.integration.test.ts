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

    // Re-registers the processor against a market contract version. Called
    // without one for the default setup, where the handler has no config and the
    // legacy bundle rules stay dormant.
    function registerProcessor(version?: string): void {
        if (destroyProcessor) {
            destroyProcessor();
        }

        processor = new DataProcessor(ProcessingState.HEAD, createMockModuleLoader());
        db = createTestTransaction(client);
        destroyProcessor = auctionProcessor(createMockCore({}, version) as any, processor, createMockNotifier());
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

    async function createAuctionInDB(auctionId: string, block?: any, assetIds: string[] = ['1001', '1002']): Promise<void> {
        const b = block || createBlock();
        const tx = createTx();
        const data: LogNewAuctionActionData = {
            auction_id: auctionId,
            seller: 'seller111111',
            asset_ids: assetIds,
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

    describe('legacy bundle auctions', () => {
        async function bid(auctionId: string): Promise<void> {
            const data: AuctionBidActionData = {
                bidder: 'bidder111111',
                auction_id: auctionId,
                bid: '10.0000 WAX',
                taker_marketplace: 'taker1111111',
            };
            await processActionTrace(
                processor, db, createBlock(), createTx(),
                createActionTrace(MARKET_CONTRACT, 'auctionbid', data)
            );
        }

        async function readAuction(auctionId: string): Promise<any> {
            const result = await client.query(
                'SELECT * FROM atomicmarket_auctions WHERE market_contract = $1 AND auction_id = $2',
                [MARKET_CONTRACT, auctionId]
            );

            return result.rows[0];
        }

        async function countBids(auctionId: string): Promise<number> {
            const result = await client.query(
                'SELECT COUNT(*) FROM atomicmarket_auctions_bids WHERE market_contract = $1 AND auction_id = $2',
                [MARKET_CONTRACT, auctionId]
            );

            return parseInt(result.rows[0].count, 10);
        }

        it('records a bid on a v2 bundle as canceled, with no bid row and no winner', async () => {
            registerProcessor('2.0.0');
            await createAuctionInDB('700101');

            await bid('700101');

            const auction = await readAuction('700101');
            expect(auction.state).to.equal(AuctionState.CANCELED.valueOf());
            expect(auction.buyer).to.be.null;
            expect(await countBids('700101')).to.equal(0);
        });

        it('records a bid on a v2 single-asset auction', async () => {
            registerProcessor('2.0.0');
            await createAuctionInDB('700102', undefined, ['1001']);

            await bid('700102');

            const auction = await readAuction('700102');
            expect(auction.buyer).to.equal('bidder111111');
            expect(auction.price).to.equal('100000');
            expect(await countBids('700102')).to.equal(1);
        });

        it('records a bid on a v1 bundle, because that contract still takes it', async () => {
            registerProcessor('1.2.2');
            await createAuctionInDB('700103');

            await bid('700103');

            const auction = await readAuction('700103');
            expect(auction.buyer).to.equal('bidder111111');
            expect(await countBids('700103')).to.equal(1);
        });

        it('records a seller claim on an unclaimed v2 bundle as canceled', async () => {
            registerProcessor('2.0.0');
            await createAuctionInDB('700104');

            const claimData: AuctionClaimSellerActionData = {auction_id: '700104'};
            await processActionTrace(
                processor, db, createBlock(), createTx(),
                createActionTrace(MARKET_CONTRACT, 'auctclaimsel', claimData)
            );

            const auction = await readAuction('700104');
            expect(auction.state).to.equal(AuctionState.CANCELED.valueOf());
            expect(auction.claimed_by_seller).to.equal(false);
        });

        it('records the normal claim when the seller already claimed the v2 bundle', async () => {
            registerProcessor('2.0.0');
            await createAuctionInDB('700105');
            await client.query(
                'UPDATE atomicmarket_auctions SET claimed_by_seller = true WHERE market_contract = $1 AND auction_id = $2',
                [MARKET_CONTRACT, '700105']
            );

            const claimData: AuctionClaimBuyerActionData = {auction_id: '700105'};
            await processActionTrace(
                processor, db, createBlock(), createTx(),
                createActionTrace(MARKET_CONTRACT, 'auctclaimbuy', claimData)
            );

            const auction = await readAuction('700105');
            expect(auction.claimed_by_buyer).to.equal(true);
            expect(auction.state).to.equal(AuctionState.WAITING.valueOf());
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
