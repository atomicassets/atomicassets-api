import {expect} from 'chai';
import {initAtomicMarketTest} from '../test';
import {RequestValues} from '../../utils';
import {getTestContext} from '../../../../utils/test';
import {getTemplateBuyOfferAction, getTemplateBuyOffersAction} from './template-buyoffers';
import {ApiError} from '../../../error';

// TODO add more tests
describe('template buy offer handler', () => {
    const {client, txit} = initAtomicMarketTest();

    async function getBuyOffersIds(values: RequestValues): Promise<Array<number>> {
        const testContext = getTestContext(client);

        const result = await getTemplateBuyOffersAction(values, testContext);

        return result.map((s: any) => s.buyoffer_id);
    }

    describe('getTemplateBuyOffers', () => {

        // The listing's own copy of the name sort expression carries the four
        // layers formatAsset merges, so an asset named only through its
        // template's mutable data orders on that name.
        txit('orders by asset name from the template mutable data', async () => {
            const buyOffer1 = await client.createTemplateBuyOffer();
            const buyOffer2 = await client.createTemplateBuyOffer();

            const asset1 = await client.createAsset({
                template_id: buyOffer1.template_id,
            });
            await client.createTemplateBuyOfferAssets({
                asset_id: asset1.asset_id,
                buyoffer_id: buyOffer1.buyoffer_id,
            });

            const asset2 = await client.createAsset({
                template_id: buyOffer2.template_id,
            });
            await client.createTemplateBuyOfferAssets({
                asset_id: asset2.asset_id,
                buyoffer_id: buyOffer2.buyoffer_id,
            });

            await client.createTemplate({
                template_id: buyOffer1.template_id,
                mutable_data: {name: 'A'},
            });

            await client.createTemplate({
                template_id: buyOffer2.template_id,
                immutable_data: {name: 'Z'},
            });

            expect(await getBuyOffersIds({sort: 'name', order: 'asc'}))
                .to.deep.equal([buyOffer1.buyoffer_id, buyOffer2.buyoffer_id]);
        });

        txit('orders by asset name', async () => {
            const buyOffer1 = await client.createTemplateBuyOffer();
            const buyOffer2 = await client.createTemplateBuyOffer();
            const buyOffer3 = await client.createTemplateBuyOffer();

            const asset1 = await client.createAsset({
                mutable_data: {name: 'Z'},
                template_id: buyOffer1.template_id,
            });
            await client.createTemplateBuyOfferAssets({
                asset_id: asset1.asset_id,
                buyoffer_id: buyOffer1.buyoffer_id,
            });

            const asset2 = await client.createAsset({
                immutable_data: {name: 'A'},
                template_id: buyOffer2.template_id,
            });
            await client.createTemplateBuyOfferAssets({
                asset_id: asset2.asset_id,
                buyoffer_id: buyOffer2.buyoffer_id,
            });

            await client.createTemplate({
                template_id: buyOffer1.template_id,
            });

            await client.createTemplate({
                template_id: buyOffer2.template_id,
            });

            await client.createTemplate({
                template_id: buyOffer3.template_id,
                immutable_data: {name: 'H'}
            });

            expect(await getBuyOffersIds({sort: 'name', order: 'asc'}))
                .to.deep.equal([buyOffer2.buyoffer_id, buyOffer3.buyoffer_id, buyOffer1.buyoffer_id]);
        });

        // template_mint filter/sort parity with sales/auctions/buyoffers. These
        // were dead for SOLD template_buyoffers until the mint drain was wired up
        // (1.7.5) - the column was always NULL, so the filter silently excluded
        // every SOLD row and the sort dumped them all at the end. The drain now
        // populates template_mint; these lock in the resulting behaviour.
        //
        // template_mint is an int4range on the listing; pass the range literal
        // directly (the drain would compute it from the fulfilling asset's mint).
        // Each buyoffer needs its template row to exist or the master view drops it.
        async function createBuyOfferWithMint(template_mint?: string): Promise<number> {
            const buyOffer = await client.createTemplateBuyOffer(template_mint ? {template_mint} : {});
            await client.createTemplate({template_id: buyOffer.template_id});

            return buyOffer.buyoffer_id;
        }

        txit('filters by minimum and maximum template mint', async () => {
            await createBuyOfferWithMint();                 // unset mint (NULL)
            await createBuyOfferWithMint('[1,2)');
            await createBuyOfferWithMint('[10,11)');

            const buyoffer_id = await createBuyOfferWithMint('[5,5]');

            expect(await getBuyOffersIds({min_template_mint: '4', max_template_mint: '6'}))
                .to.deep.equal([buyoffer_id]);
        });

        txit('filters by minimum template mint (excludes unset and empty mints)', async () => {
            await createBuyOfferWithMint();                 // unset mint (NULL)
            await createBuyOfferWithMint('empty');          // resolved, no nft

            const buyoffer_id = await createBuyOfferWithMint('[1,2)');

            expect(await getBuyOffersIds({min_template_mint: '1'}))
                .to.deep.equal([buyoffer_id]);
        });

        txit('orders by template_mint', async () => {
            const buyoffer_id1 = await createBuyOfferWithMint('[2,3)');
            const buyoffer_id2 = await createBuyOfferWithMint('[1,2)');

            expect(await getBuyOffersIds({sort: 'template_mint'}))
                .to.deep.equal([buyoffer_id1, buyoffer_id2]);
        });

        txit('orders by template_mint asc', async () => {
            const buyoffer_id1 = await createBuyOfferWithMint('[1,2)');
            const buyoffer_id2 = await createBuyOfferWithMint('[2,3)');

            expect(await getBuyOffersIds({sort: 'template_mint', order: 'asc'}))
                .to.deep.equal([buyoffer_id1, buyoffer_id2]);
        });

        txit('rejects the ending sort, which template buyoffers have no column for', async () => {
            let err;
            try {
                await getTemplateBuyOffersAction({sort: 'ending'}, getTestContext(client));
            } catch (e) {
                err = e;
            }

            expect(err).to.be.instanceof(ApiError);
            expect((err as any).message).to.equal('Invalid value for parameter sort');
        });

        context('sort hint', () => {
            // Template-buyoffer filters are btree-checkable equalities, so Postgres streams
            // the ordered price index under an Incremental Sort and stops once the limit is
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
                const buyOffer = await client.createTemplateBuyOffer();
                const asset = await client.createAsset({template_id: buyOffer.template_id});
                await client.createTemplateBuyOfferAssets({
                    asset_id: asset.asset_id,
                    buyoffer_id: buyOffer.buyoffer_id,
                });
                await client.createTemplate({template_id: buyOffer.template_id});

                const {ctx, queries} = captureContext();
                await getTemplateBuyOffersAction({sort: 'price', seller: buyOffer.seller}, ctx);

                const listing = queries.find(q =>
                    q.includes('FROM atomicmarket_template_buyoffers listing') && q.includes('ORDER BY listing.')) ?? '';

                expect(listing).to.include('ORDER BY listing.price');
                expect(listing).to.not.include('+ 0');
                expect(listing).to.not.include('+ 1');
            });
        });

    });

    describe('current_collection_fee (live-fee enrichment)', () => {
        txit('exposes current_collection_fee equal to the collection market_fee', async () => {
            const {collection_name} = await client.createCollection({market_fee: 0.07});
            const buyOffer = await client.createTemplateBuyOffer({collection_name});
            await client.createTemplate({template_id: buyOffer.template_id, collection_name});

            const result = await getTemplateBuyOfferAction({}, getTestContext(client, {buyoffer_id: buyOffer.buyoffer_id}));

            expect(result.current_collection_fee).to.equal(0.07);
        });

        txit('reflects live collection market_fee changes while the listing snapshot (collection.market_fee) stays fixed', async () => {
            const {collection_name} = await client.createCollection({market_fee: 0.05});
            const buyOffer = await client.createTemplateBuyOffer({collection_name, collection_fee: 0.05});
            await client.createTemplate({template_id: buyOffer.template_id, collection_name});

            await client.query(
                'UPDATE atomicassets_collections SET market_fee = $1 WHERE collection_name = $2',
                [0.09, collection_name]
            );

            const result = await getTemplateBuyOfferAction({}, getTestContext(client, {buyoffer_id: buyOffer.buyoffer_id}));

            expect(result.current_collection_fee).to.equal(0.09);
            expect(result.collection.market_fee).to.equal(0.05);
        });
    });

    after(async () => {
        await client.end();
    });
});
