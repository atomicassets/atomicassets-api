import {expect} from 'chai';
import {initAtomicMarketTest} from '../test';
import {RequestValues} from '../../utils';
import {getTestContext} from '../../../../utils/test';
import {getBuyOfferAction, getBuyOffersAction} from './buyoffers';
import {ApiError} from '../../../error';

// TODO add more tests
describe('buy offer handler', () => {
    const {client, txit} = initAtomicMarketTest();

    async function getBuyOffersIds(values: RequestValues): Promise<Array<number>> {
        const testContext = getTestContext(client);

        const result = await getBuyOffersAction(values, testContext);

        return result.map((s: any) => s.buyoffer_id);
    }

    describe('getBuyOffers', () => {

        // The listing's own copy of the name sort expression carries the four
        // layers formatAsset merges, so an asset named only through its
        // template's mutable data orders on that name.
        txit('orders by asset name from the template mutable data', async () => {
            const buyOffer1 = await client.createBuyOffer();
            const buyOffer2 = await client.createBuyOffer();

            const asset1 = await client.createAsset({
                template_id: (await client.createTemplate({
                    mutable_data: {name: 'A'}
                })).template_id,
            });
            await client.createBuyOfferAssets({
                asset_id: asset1.asset_id,
                buyoffer_id: buyOffer1.buyoffer_id,
            });

            const asset2 = await client.createAsset({
                template_id: (await client.createTemplate({
                    immutable_data: {name: 'Z'}
                })).template_id,
            });
            await client.createBuyOfferAssets({
                asset_id: asset2.asset_id,
                buyoffer_id: buyOffer2.buyoffer_id,
            });

            expect(await getBuyOffersIds({sort: 'name', order: 'asc'}))
                .to.deep.equal([buyOffer1.buyoffer_id, buyOffer2.buyoffer_id]);
        });

        txit('orders by asset name', async () => {

            const buyOffer1 = await client.createBuyOffer();
            const buyOffer2 = await client.createBuyOffer();
            const buyOffer3 = await client.createBuyOffer();

            const asset1 = await client.createAsset({
                mutable_data: {name: 'Z'},
            });
            await client.createBuyOfferAssets({
                asset_id: asset1.asset_id,
                buyoffer_id: buyOffer1.buyoffer_id,
            });

            const asset2 = await client.createAsset({
                immutable_data: {name: 'A'},
            });
            await client.createBuyOfferAssets({
                asset_id: asset2.asset_id,
                buyoffer_id: buyOffer2.buyoffer_id,
            });

            const asset3 = await client.createAsset({
                template_id: (await client.createTemplate({
                    immutable_data: {name: 'H'}
                })).template_id,
            });
            await client.createBuyOfferAssets({
                asset_id: asset3.asset_id,
                buyoffer_id: buyOffer3.buyoffer_id,
            });

            expect(await getBuyOffersIds({sort: 'name', order: 'asc'}))
                .to.deep.equal([buyOffer2.buyoffer_id, buyOffer3.buyoffer_id, buyOffer1.buyoffer_id]);
        });

        txit('rejects the ending sort, which buyoffers have no column for', async () => {
            let err;
            try {
                await getBuyOffersAction({sort: 'ending'}, getTestContext(client));
            } catch (e) {
                err = e;
            }

            expect(err).to.be.instanceof(ApiError);
            expect((err as any).message).to.equal('Invalid value for parameter sort');
        });

        context('sort hint', () => {
            // Buyoffer filters are btree-checkable equalities, so Postgres streams the
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
                const {seller} = await client.createBuyOffer();

                const {ctx, queries} = captureContext();
                await getBuyOffersAction({sort: 'price', seller}, ctx);

                const listing = queries.find(q =>
                    q.includes('FROM atomicmarket_buyoffers listing') && q.includes('ORDER BY listing.')) ?? '';

                expect(listing).to.include('ORDER BY listing.price');
                expect(listing).to.not.include('+ 0');
                expect(listing).to.not.include('+ 1');
            });
        });

    });

    describe('current_collection_fee (live-fee enrichment)', () => {
        txit('exposes current_collection_fee equal to the collection market_fee', async () => {
            const {collection_name} = await client.createCollection({market_fee: 0.07});
            const {buyoffer_id} = await client.createBuyOffer({collection_name});

            const result = await getBuyOfferAction({}, getTestContext(client, {buyoffer_id}));

            expect(result.current_collection_fee).to.equal(0.07);
        });

        txit('reflects live collection market_fee changes while the listing snapshot (collection.market_fee) stays fixed', async () => {
            const {collection_name} = await client.createCollection({market_fee: 0.05});
            const {buyoffer_id} = await client.createBuyOffer({collection_name, collection_fee: 0.05});

            await client.query(
                'UPDATE atomicassets_collections SET market_fee = $1 WHERE collection_name = $2',
                [0.09, collection_name]
            );

            const result = await getBuyOfferAction({}, getTestContext(client, {buyoffer_id}));

            expect(result.current_collection_fee).to.equal(0.09);
            expect(result.collection.market_fee).to.equal(0.05);
        });
    });

    after(async () => {
        await client.end();
    });
});
