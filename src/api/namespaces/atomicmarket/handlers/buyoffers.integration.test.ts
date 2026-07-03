import {expect} from 'chai';
import {initAtomicMarketTest} from '../test';
import {RequestValues} from '../../utils';
import {getTestContext} from '../../../../utils/test';
import {getBuyOfferAction, getBuyOffersAction} from './buyoffers';

// TODO add more tests
describe('buy offer handler', () => {
    const {client, txit} = initAtomicMarketTest();

    async function getBuyOffersIds(values: RequestValues): Promise<Array<number>> {
        const testContext = getTestContext(client);

        const result = await getBuyOffersAction(values, testContext);

        return result.map((s: any) => s.buyoffer_id);
    }

    describe('getBuyOffers', () => {

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
