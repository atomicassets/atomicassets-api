import {expect} from 'chai';

import {initAtomicMarketTest} from '../test';
import {RequestValues} from '../../utils';
import {getTestContext} from '../../../../utils/test';
import {getAuctionAction, getAuctionsAction} from './auctions';
import {AuctionApiState} from '../index';
import sinon from 'sinon';
import {clearMarketVersionCache, MARKET_VERSION_CACHE_TTL_MS} from '../market-version';

// TODO add more tests
describe('auction handler', () => {
    const {client, txit} = initAtomicMarketTest();

    async function getAuctionsIds(values: RequestValues): Promise<Array<number>> {
        const testContext = getTestContext(client);

        const result = await getAuctionsAction(values, testContext);

        return result.map((s: any) => s.auction_id);
    }

    describe('getAuctions', () => {
        txit('returns empty on no auctions', async () => {
            expect(await getAuctionsIds({})).to.deep.equal([]);
        });

        txit('returns all auctions without filters', async () => {
            const auction = await client.createAuction();
            const auction2 = await client.createAuction();

            expect((await getAuctionsIds({})).sort())
                .to.deep.equal([auction.auction_id, auction2.auction_id].sort());
        });

        context('with template_blacklist args', () => {
            txit('filter out auctions the given template matching the blacklist', async () => {
                const auction = await client.createAuction();
                const asset = await client.createAsset({
                    template_id: (await client.createTemplate()).template_id,
                });
                await client.createAuctionAssets({
                    asset_id: asset.asset_id,
                    auction_id: auction.auction_id,
                });

                // excluded
                const auction2 = await client.createAuction();
                const asset2 = await client.createAsset({
                    template_id: (await client.createTemplate()).template_id,
                });
                await client.createAuctionAssets({
                    asset_id: asset2.asset_id,
                    auction_id: auction2.auction_id,
                });

                expect(await getAuctionsIds({template_blacklist: [asset2.template_id].join(',')}))
                    .to.deep.equal([auction.auction_id]);
            });
        });

        // The listing's own copy of the name sort expression carries the four
        // layers formatAsset merges, so an asset named only through its
        // template's mutable data orders on that name.
        txit('orders by asset name from the template mutable data', async () => {
            const auction1 = await client.createAuction();
            const auction2 = await client.createAuction();

            const asset1 = await client.createAsset({
                template_id: (await client.createTemplate({
                    mutable_data: {name: 'A'}
                })).template_id,
            });
            await client.createAuctionAssets({
                asset_id: asset1.asset_id,
                auction_id: auction1.auction_id,
            });

            const asset2 = await client.createAsset({
                template_id: (await client.createTemplate({
                    immutable_data: {name: 'Z'}
                })).template_id,
            });
            await client.createAuctionAssets({
                asset_id: asset2.asset_id,
                auction_id: auction2.auction_id,
            });

            expect(await getAuctionsIds({sort: 'name', order: 'asc'}))
                .to.deep.equal([auction1.auction_id, auction2.auction_id]);
        });

        txit('orders by asset name', async () => {

            const auction1 = await client.createAuction();
            const auction2 = await client.createAuction();
            const auction3 = await client.createAuction();

            const asset1 = await client.createAsset({
                mutable_data: {name: 'Z'},
            });
            await client.createAuctionAssets({
                asset_id: asset1.asset_id,
                auction_id: auction1.auction_id,
            });

            const asset2 = await client.createAsset({
                immutable_data: {name: 'A'},
            });
            await client.createAuctionAssets({
                asset_id: asset2.asset_id,
                auction_id: auction2.auction_id,
            });

            const asset3 = await client.createAsset({
                template_id: (await client.createTemplate({
                    immutable_data: {name: 'H'}
                })).template_id,
            });
            await client.createAuctionAssets({
                asset_id: asset3.asset_id,
                auction_id: auction3.auction_id,
            });

            expect(await getAuctionsIds({sort: 'name', order: 'asc'}))
                .to.deep.equal([auction2.auction_id, auction3.auction_id, auction1.auction_id]);
        });

        context('sort hint', () => {
            // Auction filters are btree-checkable equalities, so Postgres streams the
            // ordered price index under an Incremental Sort and stops once the limit is
            // filled. An arithmetic hint on the ORDER BY would discard that plan for a full
            // scan plus top-N sort, so its absence is pinned here rather than left to
            // inference. `seller` is the filter the listing-filter heuristic keyed on, so a
            // restore of that heuristic in particular is caught. The opposite case lives in
            // sales2: a lossy GIN containment has no ordered index that satisfies it, and
            // there the hint is correct.
            function captureContext(): { ctx: any, queries: string[] } {
                const queries: string[] = [];
                const db = {
                    query: async (text: string, values?: any[]): Promise<any> => {
                        queries.push(text);
                        return client.query(text, values);
                    },
                };
                return {ctx: getTestContext(db as any), queries};
            }

            txit('leaves a price sort with a seller filter unhinted', async () => {
                const {seller} = await client.createAuction();

                const {ctx, queries} = captureContext();
                await getAuctionsAction({sort: 'price', seller}, ctx);

                const listing = queries.find(q =>
                    q.includes('FROM atomicmarket_auctions listing') && q.includes('ORDER BY listing.')) ?? '';

                expect(listing).to.include('ORDER BY listing.price');
                expect(listing).to.not.include('+ 0');
                expect(listing).to.not.include('+ 1');
            });
        });

    });

    describe('current_collection_fee (live-fee enrichment)', () => {
        txit('exposes current_collection_fee equal to the collection market_fee', async () => {
            const {collection_name} = await client.createCollection({market_fee: 0.07});
            const {auction_id} = await client.createAuction({collection_name});

            const result = await getAuctionAction({}, getTestContext(client, {auction_id}));

            expect(result.current_collection_fee).to.equal(0.07);
        });

        txit('reflects live collection market_fee changes while the listing snapshot (collection.market_fee) stays fixed', async () => {
            const {collection_name} = await client.createCollection({market_fee: 0.05});
            const {auction_id} = await client.createAuction({collection_name, collection_fee: 0.05});

            await client.query(
                'UPDATE atomicassets_collections SET market_fee = $1 WHERE collection_name = $2',
                [0.09, collection_name]
            );

            const result = await getAuctionAction({}, getTestContext(client, {auction_id}));

            expect(result.current_collection_fee).to.equal(0.09);
            expect(result.collection.market_fee).to.equal(0.05);
        });
    });

    describe('legacy bundle auctions', () => {
        // An ended auction with a bid derives SOLD at read time. On a v2 contract a
        // multi-asset auction cannot settle, so it must derive INVALID instead, and
        // the state filter has to agree with the formatted row.
        const ENDED = Math.floor(Date.now() / 1000) - 3600;

        // The api reads the contract version from atomicmarket_config, so a test
        // sets the deployment's version by writing that row.
        async function setMarketVersion(version: string): Promise<void> {
            await client.query('DELETE FROM atomicmarket_config WHERE market_contract = $1', ['amtest']);
            await client.query(
                'INSERT INTO atomicmarket_config (' +
                    'market_contract, assets_contract, delphi_contract, version, maker_market_fee, taker_market_fee, ' +
                    'minimum_auction_duration, maximum_auction_duration, minimum_bid_increase, auction_reset_duration' +
                ') VALUES ($1, $2, $3, $4, 0.01, 0.01, 3600, 2592000, 0.1, 120)',
                ['amtest', 'aatest', 'dotest', version]
            );

            clearMarketVersionCache();
        }

        async function createEndedAuction(
            assetCount: number, claims: Record<string, any> = {}
        ): Promise<Record<string, any>> {
            const auction = await client.createAuction({end_time: ENDED, buyer: 'bidder', ...claims});

            for (let index = 1; index <= assetCount; index++) {
                await client.createAuctionAssets({auction_id: auction.auction_id, index});
            }

            return auction;
        }

        txit('formats an ended bundle auction as invalid on a v2 contract', async () => {
            await setMarketVersion('2.0.0');
            const {auction_id} = await createEndedAuction(2);

            const result = await getAuctionAction({}, getTestContext(client, {auction_id}));

            expect(result.state).to.equal(AuctionApiState.INVALID.valueOf());
        });

        txit('formats an ended single-asset auction as sold on a v2 contract', async () => {
            await setMarketVersion('2.0.0');
            const {auction_id} = await createEndedAuction(1);

            const result = await getAuctionAction({}, getTestContext(client, {auction_id}));

            expect(result.state).to.equal(AuctionApiState.SOLD.valueOf());
        });

        txit('formats an ended bundle auction as sold on a v1 contract', async () => {
            await setMarketVersion('1.2.2');
            const {auction_id} = await createEndedAuction(2);

            const result = await getAuctionAction({}, getTestContext(client, {auction_id}));

            expect(result.state).to.equal(AuctionApiState.SOLD.valueOf());
        });

        txit('leaves an ended bundle auction out of a sold query on a v2 contract', async () => {
            await setMarketVersion('2.0.0');
            const bundle = await createEndedAuction(2);
            const single = await createEndedAuction(1);

            const result = await getAuctionsAction(
                {state: String(AuctionApiState.SOLD.valueOf())}, getTestContext(client)
            );

            expect(result.map((row: any) => row.auction_id)).to.deep.equal([single.auction_id]);
            expect(bundle.auction_id).to.not.be.undefined;
        });

        txit('puts an ended bundle auction in an invalid query on a v2 contract', async () => {
            await setMarketVersion('2.0.0');
            const bundle = await createEndedAuction(2);
            await createEndedAuction(1);

            const result = await getAuctionsAction(
                {state: String(AuctionApiState.INVALID.valueOf())}, getTestContext(client)
            );

            expect(result.map((row: any) => row.auction_id)).to.deep.equal([bundle.auction_id]);
        });

        txit('keeps a partially claimed ended bundle auction sold, in the row and in the query', async () => {
            // The remaining claim is a real settlement, so this one is not
            // reclassified. formatAuction and the state filter have to agree on it.
            await setMarketVersion('2.0.0');
            const claimed = await createEndedAuction(2, {claimed_by_seller: true});

            const row = await getAuctionAction({}, getTestContext(client, {auction_id: claimed.auction_id}));
            const sold = await getAuctionsAction(
                {state: String(AuctionApiState.SOLD.valueOf())}, getTestContext(client)
            );
            const invalid = await getAuctionsAction(
                {state: String(AuctionApiState.INVALID.valueOf())}, getTestContext(client)
            );

            expect(row.state).to.equal(AuctionApiState.SOLD.valueOf());
            expect(sold.map((entry: any) => entry.auction_id)).to.deep.equal([claimed.auction_id]);
            expect(invalid.map((entry: any) => entry.auction_id)).to.deep.equal([]);
        });

        txit('follows a version flip under a running api, with no restart', async () => {
            // The flip lands on a fleet nobody restarts, so the derived state has
            // to follow the config row rather than the process lifetime.
            await setMarketVersion('1.2.2');
            const {auction_id} = await createEndedAuction(2);

            const beforeFlip = await getAuctionAction({}, getTestContext(client, {auction_id}));
            expect(beforeFlip.state).to.equal(AuctionApiState.SOLD.valueOf());

            await client.query(
                'UPDATE atomicmarket_config SET version = $1 WHERE market_contract = $2',
                ['2.0.0', 'amtest']
            );

            // Same process, same namespace, only the clock moves past the cache TTL.
            const clock = sinon.useFakeTimers({now: Date.now(), toFake: ['Date']});

            try {
                clock.tick(MARKET_VERSION_CACHE_TTL_MS + 1);

                const afterFlip = await getAuctionAction({}, getTestContext(client, {auction_id}));

                expect(afterFlip.state).to.equal(AuctionApiState.INVALID.valueOf());
            } finally {
                clock.restore();
            }
        });

        txit('keeps an ended bundle auction in a sold query on a v1 contract', async () => {
            await setMarketVersion('1.2.2');
            const bundle = await createEndedAuction(2);
            const single = await createEndedAuction(1);

            const result = await getAuctionsAction(
                {state: String(AuctionApiState.SOLD.valueOf())}, getTestContext(client)
            );

            expect(result.map((row: any) => row.auction_id).sort())
                .to.deep.equal([bundle.auction_id, single.auction_id].sort());
        });
    });

    after(async () => {
        await client.end();
    });
});
