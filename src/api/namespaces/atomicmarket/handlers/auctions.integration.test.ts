import {expect} from 'chai';

import {initAtomicMarketTest} from '../test';
import {RequestValues} from '../../utils';
import {getTestContext} from '../../../../utils/test';
import {getAuctionAction, getAuctionsAction} from './auctions';

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

    after(async () => {
        await client.end();
    });
});
