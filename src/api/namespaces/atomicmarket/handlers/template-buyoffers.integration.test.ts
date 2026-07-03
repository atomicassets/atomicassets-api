import {expect} from 'chai';
import {initAtomicMarketTest} from '../test';
import {RequestValues} from '../../utils';
import {getTestContext} from '../../../../utils/test';
import {getTemplateBuyOfferAction, getTemplateBuyOffersAction} from './template-buyoffers';

// TODO add more tests
describe('template buy offer handler', () => {
    const {client, txit} = initAtomicMarketTest();

    async function getBuyOffersIds(values: RequestValues): Promise<Array<number>> {
        const testContext = getTestContext(client);

        const result = await getTemplateBuyOffersAction(values, testContext);

        return result.map((s: any) => s.buyoffer_id);
    }

    describe('getTemplateBuyOffers', () => {

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
