import 'mocha';
import {expect} from 'chai';
import {RequestValues} from '../../utils';
import {initAtomicMarketTest} from '../test';
import {getTestContext} from '../../../../utils/test';
import {getSalesTemplatesV2Action} from './sales2';
import {ApiError} from '../../../error';
import {createMintAsset} from '../effective-mint-suite';

const {client, txit} = initAtomicMarketTest();

async function getSalesIds(values: RequestValues): Promise<Array<number>> {
    const testContext = getTestContext(client);

    await client.refreshSalesFilters();

    const result = await getSalesTemplatesV2Action({
        symbol: 'TEST',
        ...values,
    }, testContext);

    return result.map((s: any) => s.sale_id);
}

async function initTest(saleValues: Record<string, any> = {}): Promise<{template_id: number, sale_id: number}> {
    const {template_id} = await client.createTemplate();

    const {offer_id} = await client.createOfferAsset({}, {template_id});
    const {sale_id} = await client.createSale({
        offer_id,
        ...saleValues,
    });

    return {
        sale_id,
        template_id: (await client.createTemplate()).template_id,
    };
}

describe('AtomicMarket Sales API', () => {

    describe('getSalesTemplatesAction', () => {

        txit('filters by settlement symbol', async () => {
            const {template_id} = await initTest();
            await client.createToken({token_symbol: 'TOKEN1'});
            const {offer_id} = await client.createOfferAsset({}, {template_id});
            const {sale_id} = await client.createSale({offer_id, settlement_symbol: 'TOKEN1'});

            expect(await getSalesIds({symbol: 'TOKEN1', burned: false}))
                .to.deep.equal([sale_id]);
        });

        txit('filters by minimum price', async () => {
            const {template_id} = await initTest({
                listing_price: 100000000,
            });

            const {offer_id} = await client.createOfferAsset({}, {template_id});
            const {sale_id} = await client.createSale({
                offer_id,
                listing_price: 200000000,
            });

            expect(await getSalesIds({min_price: '2', burned: false}))
                .to.deep.equal([sale_id]);
        });

        txit('filters by maximum price', async () => {
            const {template_id} = await initTest({
                listing_price: 300000000,
            });

            const {offer_id} = await client.createOfferAsset({}, {template_id});
            const {sale_id} = await client.createSale({
                offer_id,
                listing_price: 200000000,
            });

            expect(await getSalesIds({max_price: '2', burned: false}))
                .to.deep.equal([sale_id]);
        });

        txit('filters by collection', async () => {
            const {template_id} = await initTest();

            const {collection_name} = await client.createCollection({collection_name: 'x'});

            const {offer_id} = await client.createOfferAsset({}, {template_id, collection_name});
            const {sale_id} = await client.createSale({offer_id, collection_name});

            expect(await getSalesIds({collection_name: 'x,abc'}))
                .to.deep.equal([sale_id]);
        });

        txit('filters by asset_id', async () => {
            const {template_id} = await initTest();

            const {asset_id, offer_id} = await client.createOfferAsset({}, {template_id});
            const {sale_id} = await client.createSale({offer_id});

            expect(await getSalesIds({asset_id}))
                .to.deep.equal([sale_id]);
        });

        txit('only returns single asset sales', async () => {
            const {template_id, sale_id} = await initTest();

            const {offer_id} = await client.createOfferAsset({}, {template_id});
            await client.createOfferAsset({offer_id, index: 2}, {
                template_id: (await client.createTemplate()).template_id,
            });

            await client.createSale({offer_id});

            expect(await getSalesIds({burned: false}))
                .to.deep.equal([sale_id]);
        });

        txit('filters by asset owner', async () => {
            const {template_id} = await initTest();

            const {offer_id} = await client.createOfferAsset({}, {template_id, owner: 'x'});
            const {sale_id} = await client.createSale({offer_id});

            expect(await getSalesIds({owner: 'x,abc'}))
                .to.deep.equal([sale_id]);
        });

        txit('filters by asset burned', async () => {
            const {template_id} = await initTest();

            const {offer_id} = await client.createOfferAsset({}, {template_id, owner: null});
            const {sale_id} = await client.createSale({offer_id});

            expect(await getSalesIds({burned: 'true'}))
                .to.deep.equal([sale_id]);
        });

        txit('filters by asset not burned', async () => {
            const {template_id, sale_id} = await initTest();

            const {offer_id} = await client.createOfferAsset({}, {template_id, owner: null});
            await client.createSale({offer_id});

            expect(await getSalesIds({burned: 'false'}))
                .to.deep.equal([sale_id]);
        });

        txit('filters by asset template', async () => {
            const {template_id} = await initTest();

            const {offer_id} = await client.createOfferAsset({}, {template_id});
            const {sale_id} = await client.createSale({offer_id});

            expect(await getSalesIds({template_id: `${template_id},-1`}))
                .to.deep.equal([sale_id]);
        });

        txit('ignores sales without a template', async () => {
            const {sale_id} = await initTest();

            const {offer_id} = await client.createOfferAsset();
            await client.createSale({offer_id});

            expect(await getSalesIds({burned: false}))
                .to.deep.equal([sale_id]);
        });

        txit('filters by schema', async () => {
            const {template_id} = await initTest();

            const {schema_name} = await client.createSchema();

            const {offer_id} = await client.createOfferAsset({}, {template_id, schema_name});
            const {sale_id} = await client.createSale({offer_id});

            expect(await getSalesIds({schema_name: `${schema_name},z`}))
                .to.deep.equal([sale_id]);
        });

        txit('filters by asset being transferable', async () => {
            const offer1 = await client.createOfferAsset({}, {
                template_id: (await client.createTemplate({transferable: false})).template_id,
            });
            await client.createSale({offer_id: offer1.offer_id});

            const {template_id} = await client.createTemplate({transferable: true});
            const {offer_id} = await client.createOfferAsset({}, {template_id});
            const {sale_id} = await client.createSale({offer_id});

            expect(await getSalesIds({is_transferable: 'true'}))
                .to.deep.equal([sale_id]);
        });

        txit('filters by asset not being transferable', async () => {
            const offer1 = await client.createOfferAsset({}, {
                template_id: (await client.createTemplate({transferable: true})).template_id,
            });
            await client.createSale({offer_id: offer1.offer_id});

            const {template_id} = await client.createTemplate({transferable: false});
            const {offer_id} = await client.createOfferAsset({}, {template_id});
            const {sale_id} = await client.createSale({offer_id});

            expect(await getSalesIds({is_transferable: 'false'}))
                .to.deep.equal([sale_id]);
        });

        txit('filters by asset being burnable', async () => {
            const offer1 = await client.createOfferAsset({}, {
                template_id: (await client.createTemplate({burnable: false})).template_id,
            });
            await client.createSale({offer_id: offer1.offer_id});

            const {template_id} = await client.createTemplate({burnable: true});
            const {offer_id} = await client.createOfferAsset({}, {template_id});
            const {sale_id} = await client.createSale({offer_id});

            expect(await getSalesIds({is_burnable: 'true'}))
                .to.deep.equal([sale_id]);
        });

        txit('filters by asset not being burnable', async () => {
            const offer1 = await client.createOfferAsset({}, {
                template_id: (await client.createTemplate({burnable: true})).template_id,
            });
            await client.createSale({offer_id: offer1.offer_id});

            const {template_id} = await client.createTemplate({burnable: false});
            const {offer_id} = await client.createOfferAsset({}, {template_id});
            const {sale_id} = await client.createSale({offer_id});

            expect(await getSalesIds({is_burnable: 'false'}))
                .to.deep.equal([sale_id]);
        });

        txit('filters by text data', async () => {
            await initTest();

            const {template_id} = await client.createTemplate({immutable_data: JSON.stringify({'prop': 'TheValue'})});
            const {offer_id} = await client.createOfferAsset({}, {template_id});
            const {sale_id} = await client.createSale({offer_id});

            expect(await getSalesIds({'data:text.prop': 'TheValue', burned: false}))
                .to.deep.equal([sale_id]);
        });

        txit('filters by number template_data', async () => {
            await initTest();

            const {template_id} = await client.createTemplate({immutable_data: JSON.stringify({'prop': 1})});
            const {offer_id} = await client.createOfferAsset({}, {template_id});
            const {sale_id} = await client.createSale({offer_id});

            expect(await getSalesIds({'template_data:number.prop': 1, burned: false}))
                .to.deep.equal([sale_id]);
        });

        txit('filters by bool mutable_data', async () => {
            const {template_id} = await initTest();

            const {offer_id} = await client.createOfferAsset({}, {
                mutable_data: JSON.stringify({'prop': 1}),
                template_id,
            });
            const {sale_id} = await client.createSale({offer_id});

            expect(await getSalesIds({'mutable_data:bool.prop': 'true', burned: false}))
                .to.deep.equal([sale_id]);
        });

        txit('filters by untyped immutable_data', async () => {
            const {template_id} = await initTest();

            const {offer_id} = await client.createOfferAsset({}, {
                immutable_data: JSON.stringify({'prop': 'this'}),
                template_id,
            });
            const {sale_id} = await client.createSale({offer_id});

            expect(await getSalesIds({'immutable_data.prop': 'this', burned: false}))
                .to.deep.equal([sale_id]);
        });

        txit('filters by match_immutable_name', async () => {
            const {template_id} = await initTest();

            const offer1 = await client.createOfferAsset();
            await client.createSale({offer_id: offer1.offer_id});

            const {offer_id} = await client.createOfferAsset({}, {
                immutable_data: JSON.stringify({name: 'prefix_par%_tial_postfix'}),
                template_id,
            });
            const {sale_id} = await client.createSale({offer_id});

            expect(await getSalesIds({'match_immutable_name': 'par%_tial', burned: false}))
                .to.deep.equal([sale_id]);
        });

        txit('filters by match_mutable_name', async () => {
            const {template_id} = await initTest();

            const {offer_id} = await client.createOfferAsset({}, {
                mutable_data: JSON.stringify({name: 'prefix_par%_tial_postfix'}),
                template_id,
            });
            const {sale_id} = await client.createSale({offer_id});

            expect(await getSalesIds({'match_mutable_name': 'par%_tial', burned: false}))
                .to.deep.equal([sale_id]);
        });

        txit('filters by match (template name)', async () => {
            await initTest();

            const {template_id} = await client.createTemplate({immutable_data: JSON.stringify({name: 'prefix_par%_tial_postfix'})});
            const {offer_id} = await client.createOfferAsset({}, {template_id});
            const {sale_id} = await client.createSale({offer_id});

            expect(await getSalesIds({'match': 'par%_tial', burned: false}))
                .to.deep.equal([sale_id]);
        });

        txit('filters by collection_whitelist', async () => {
            const {template_id} = await initTest();

            const {collection_name} = await client.createCollection({collection_name: 'x'});

            const {offer_id} = await client.createOfferAsset({}, {template_id, collection_name});
            const {sale_id} = await client.createSale({offer_id, collection_name});

            expect(await getSalesIds({collection_whitelist: 'x,abc'}))
                .to.deep.equal([sale_id]);
        });

        txit('filters by collection_blacklist', async () => {
            const {collection_name} = await client.createCollection({collection_name: 'x'});
            const {template_id} = await initTest({collection_name});

            const {offer_id} = await client.createOfferAsset({}, {template_id});
            const {sale_id} = await client.createSale({offer_id});

            expect(await getSalesIds({collection_blacklist: 'x,abc', burned: false}))
                .to.deep.equal([sale_id]);
        });

        txit('orders ascending', async () => {
            const {template_id, sale_id: sale_id1} = await initTest();

            const {offer_id} = await client.createOfferAsset({}, {template_id});
            const {sale_id: sale_id2} = await client.createSale({offer_id});

            expect(await getSalesIds({burned: false, order: 'asc'}))
                .to.deep.equal([sale_id1, sale_id2]);
        });

        txit('orders descending', async () => {
            const {template_id, sale_id: sale_id1} = await initTest();

            const {offer_id} = await client.createOfferAsset({}, {template_id});
            const {sale_id: sale_id2} = await client.createSale({offer_id});

            expect(await getSalesIds({burned: false, order: 'desc'}))
                .to.deep.equal([sale_id2, sale_id1]);
        });

        txit('orders by price', async () => {
            const {template_id, sale_id: sale_id1} = await initTest({
                listing_price: 200000000,
            });

            const {offer_id} = await client.createOfferAsset({}, {template_id});
            const {sale_id: sale_id2} = await client.createSale({
                offer_id,
                listing_price: 100000000,
            });

            expect(await getSalesIds({burned: false, sort: 'price'}))
                .to.deep.equal([sale_id1, sale_id2]);
        });

        txit('orders by template_id', async () => {
            const {template_id, sale_id: sale_id1} = await initTest();

            const {offer_id} = await client.createOfferAsset({}, {template_id});
            const {sale_id: sale_id2} = await client.createSale({offer_id});

            expect(await getSalesIds({burned: false, sort: 'template_id'}))
                .to.deep.equal([sale_id2, sale_id1]);
        });

        txit('paginates', async () => {
            const {template_id} = await initTest();

            const {offer_id} = await client.createOfferAsset({}, {template_id});
            const {sale_id} = await client.createSale({offer_id});

            expect(await getSalesIds({page: '2', limit: '1', burned: false, order: 'asc'}))
                .to.deep.equal([sale_id]);
        });

        txit('formats and fills result', async () => {
            const {template_id} = await client.createTemplate();
            const {offer_id} = await client.createOfferAsset({}, {template_id});
            const {sale_id} = await client.createSale({offer_id});

            await client.refreshSalesFilters();

            const testContext = getTestContext(client);

            const [result] = await getSalesTemplatesV2Action({symbol: 'TEST', burned: false}, testContext);

            expect(result).to.not.haveOwnProperty('raw_price');
            expect(result.sale_id).to.equal(sale_id);
            expect(result).to.haveOwnProperty('state');
            expect(result).to.haveOwnProperty('price');
            expect(result.price).to.have.ownProperty('amount');
            expect(result).to.haveOwnProperty('collection');
        });
    });

    describe('effective mint filter', () => {
        async function templateSale(collectionName: string, spec: {template?: number, original?: number | null}): Promise<number> {
            const {template_id} = await client.createTemplate({collection_name: collectionName});
            const asset_id = await createMintAsset(client, collectionName, spec, {template_id});
            const {offer_id} = await client.createOffer();
            await client.createOfferAsset({offer_id, asset_id});

            return (await client.createSale({offer_id, collection_name: collectionName})).sale_id;
        }

        txit('filters by the original mint, else the template mint', async () => {
            const c = (await client.createCollection()).collection_name;
            const linked = await templateSale(c, {original: 5, template: 500});
            const unlinked = await templateSale(c, {template: 6});
            const originalWins = await templateSale(c, {original: 500, template: 5});
            const nullLink = await templateSale(c, {original: null, template: 60});
            await templateSale(c, {});

            expect((await getSalesIds({collection_name: c, min_effective_mint: '4', max_effective_mint: '7'})).sort())
                .to.deep.equal([linked, unlinked].sort());
            expect((await getSalesIds({collection_name: c, min_effective_mint: '7', max_effective_mint: '1000'})).sort())
                .to.deep.equal([originalWins, nullLink].sort());
            expect(await getSalesIds({collection_name: c, max_effective_mint: '5'})).to.deep.equal([linked]);
        });

        txit('combines a template mint bound with an effective mint bound of the same value', async () => {
            const c = (await client.createCollection()).collection_name;
            const both = await templateSale(c, {original: 5, template: 5});
            await templateSale(c, {original: 50, template: 5});
            await templateSale(c, {original: 6, template: 50});

            expect(await getSalesIds({
                collection_name: c,
                min_template_mint: '5', min_effective_mint: '5',
                max_template_mint: '6', max_effective_mint: '6',
            })).to.deep.equal([both]);
        });

        txit('requires collection_name and a valid range', async () => {
            const c = (await client.createCollection()).collection_name;
            await templateSale(c, {original: 5});

            for (const [values, message] of [
                [{collection_whitelist: c, min_effective_mint: '1'}, 'The effective mint filters and sort require collection_name'],
                [{collection_name: c, min_effective_mint: '5', max_effective_mint: '4'}, 'Min effective mint can\'t be greater than max effective mint'],
            ]) {
                let err: any;
                try {
                    await getSalesIds(values);
                } catch (e) {
                    err = e;
                }

                expect(err).to.be.instanceof(ApiError);
                expect(err.code).to.equal(400);
                expect(err.message).to.equal(message);
            }
        });
    });

    after(async () => await client.end());
});
