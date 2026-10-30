import {initAtomicMarketTest} from '../test';
import {getTestContext} from '../../../../utils/test';
import {getTemplateStatsAction} from './stats';
import {SaleApiState} from '../index';
import {expect} from 'chai';
import {OfferState} from '../../../../filler/handlers/atomicassets';

const {client, txit} = initAtomicMarketTest();

describe('AtomicMarket Stats API', () => {
    describe('getTemplateStatsAction', () => {
        txit('optionally summarizes current listings independently of historical time and paginates eligible templates', async () => {
            await client.createContractReader();
            await client.createToken({token_symbol: 'TOKEN1'});
            await client.createToken({token_symbol: 'TOKEN2'});
            const empty = await client.createTemplate();
            const listed = await client.createTemplate();
            const context = getTestContext(client);
            const base = {collection_name: listed.collection_name, listing_symbol: 'TOKEN1', settlement_symbol: 'TOKEN1', listing_price: 42};
            const bundle = await client.createFullSale({...base, state: SaleApiState.LISTED, created_at_time: 1}, {template_id: listed.template_id});
            const extra = await client.createAsset({collection_name: listed.collection_name, template_id: listed.template_id});
            await client.createOfferAsset({offer_id: bundle.offer_id, asset_id: extra.asset_id, index: 2});
            await client.createFullSale({...base, state: SaleApiState.SOLD, final_price: 1}, {template_id: listed.template_id});
            await client.createFullSale({...base, state: SaleApiState.CANCELED}, {template_id: listed.template_id});
            await client.createFullSale({...base, collection_name: empty.collection_name, listing_symbol: 'TOKEN2', settlement_symbol: 'TOKEN2'}, {template_id: empty.template_id});
            await client.refreshSalesFilters();
            await client.refreshStatsMarket();

            const plain = await getTemplateStatsAction({symbol: 'TOKEN1'}, context);
            expect(plain.results[0]).not.to.have.property('listing_count');
            const all = await getTemplateStatsAction({symbol: 'TOKEN1', include_listings: 'true', after: '100'}, context);
            const noListing = all.results.find((r: any) => r.template.template_id === empty.template_id);
            expect(noListing).to.include({listing_count: '0', lowest_listing_price: null});
            const active = all.results.find((r: any) => r.template.template_id === listed.template_id);
            expect(active.listing_count).to.equal('1');
            expect(active.lowest_listing_price).to.include({amount: '42', token_symbol: 'TOKEN1'});
            const page = await getTemplateStatsAction({
                symbol: 'TOKEN1', include_listings: 'true', hide_unlisted_templates: 'true', limit: '1'
            }, context);
            expect(page.results.map((r: any) => r.template.template_id)).to.deep.equal([listed.template_id]);
            const blocked = await getTemplateStatsAction({
                symbol: 'TOKEN1', include_listings: 'true', hide_unlisted_templates: 'true',
                collection_blacklist: listed.collection_name
            }, context);
            expect(blocked.results).to.have.length(0);
        });

        txit('rechecks stale sale and offer states and paginates eligible templates deterministically', async () => {
            await client.createContractReader();
            await client.createToken({token_symbol: 'TOKEN1'});
            const templates = [];
            const sales = [];
            for (let i = 0; i < 4; i++) {
                const template = await client.createTemplate();
                templates.push(template);
                sales.push(await client.createFullSale({
                    collection_name: template.collection_name,
                    listing_symbol: 'TOKEN1', settlement_symbol: 'TOKEN1', listing_price: 10
                }, {template_id: template.template_id}));
            }
            await client.refreshSalesFilters();
            // Leave the indexed LISTED rows stale, as can happen before the filter queue drains.
            await client.query('UPDATE atomicmarket_sales SET state = $1 WHERE market_contract = $2 AND sale_id = $3',
                [SaleApiState.SOLD, 'amtest', sales[0].sale_id]);
            await client.query('UPDATE atomicassets_offers SET state = $1 WHERE contract = $2 AND offer_id = $3',
                [OfferState.ACCEPTED, 'aatest', sales[1].offer_id]);
            const context = getTestContext(client);
            const params = {symbol: 'TOKEN1', include_listings: 'true', after: '9999999999999'};
            const all = await getTemplateStatsAction(params, context);
            for (const template of templates.slice(0, 2)) {
                expect(all.results.find((row: any) => row.template.template_id === template.template_id))
                    .to.include({listing_count: '0', lowest_listing_price: null});
            }
            for (let page = 1; page <= 2; page++) {
                const result = await getTemplateStatsAction({
                    ...params, hide_unlisted_templates: 'true', limit: '1', page: String(page)
                }, context);
                expect(result.results).to.have.length(1);
                expect(result.results[0].template.template_id).to.equal(templates[page + 1].template_id);
                expect(result.results[0].listing_count).to.equal('1');
            }
        });

        txit('gets the templates sales and volume', async () => {
            await client.createContractReader();

            await client.createToken({token_symbol: 'TOKEN1'});
            const {template_id} = await client.createTemplate();
            const {template_id: templateId2} = await client.createTemplate();

            const context = getTestContext(client);

            await client.createFullSale({
                final_price: 1,
                listing_price: 1, listing_symbol: 'TOKEN1',
                settlement_symbol: 'TOKEN1', state: SaleApiState.SOLD,
                taker_marketplace: 'X',
            }, {template_id});

            await client.createFullSale({
                final_price: 1,
                listing_price: 1,
                listing_symbol: 'TOKEN1',
                settlement_symbol: 'TOKEN1',
                state: SaleApiState.SOLD,
                taker_marketplace: 'X',
            }, {template_id});

            await client.refreshStatsMarket();

            const response = await getTemplateStatsAction({symbol: 'TOKEN1'}, context);

            expect(response.results.length).to.equal(2);
            expect(response.results.find((r: any) => r.template.template_id === template_id)).to.deep.contains({
                volume: '2',
                sales: '2'
            });

            expect(response.results.find((r: any) => r.template.template_id === templateId2)).to.deep.contains({
                volume: '0',
                sales: '0'
            });
        });

        context('with template_id filter', () => {
            txit('gets the templates sales and volume even if they dont have sales', async () => {
                await client.createContractReader();

                await client.createToken({token_symbol: 'TOKEN1'});
                const context = getTestContext(client);
                // Included
                const {template_id} = await client.createTemplate();
                // Not included
                await client.createTemplate();

                await client.refreshStatsMarket();

                const response = await getTemplateStatsAction({symbol: 'TOKEN1', template_id: template_id}, context);

                expect(response.results.length).to.equal(1);
                expect(response.results[0]).to.deep.includes({
                    volume: '0', sales: '0',
                });
                expect(response.results[0].template.template_id).to.equal(template_id);
            });
        });

        context('with schema_name filter', () => {
            txit('gets the templates sales and volume even if they dont have sales', async () => {
                await client.createContractReader();

                await client.createToken({token_symbol: 'TOKEN1'});
                const context = getTestContext(client);
                // Included
                const {schema_name, collection_name} = await client.createSchema();
                const {template_id} = await client.createTemplate({schema_name, collection_name});
                // Not included
                await client.createTemplate();

                await client.refreshStatsMarket();

                const response = await getTemplateStatsAction({symbol: 'TOKEN1', schema_name}, context);

                expect(response.results.length).to.equal(1);
                expect(response.results[0]).to.deep.includes({
                    volume: '0', sales: '0',
                });
                expect(response.results[0].template.template_id).to.equal(template_id);
            });
        });

        context('with collection_name filter', () => {
            txit('gets the templates sales and volume even if they dont have sales', async () => {
                await client.createContractReader();

                await client.createToken({token_symbol: 'TOKEN1'});
                const context = getTestContext(client);
                // Included
                const {collection_name} = await client.createCollection();
                await client.createTemplate({collection_name});
                // Not included
                await client.createTemplate();

                await client.refreshStatsMarket();

                const response = await getTemplateStatsAction({symbol: 'TOKEN1', collection_name}, context);

                expect(response.results.length).to.equal(1);
                expect(response.results[0]).to.deep.contains({
                    volume: '0', sales: '0',
                });
                expect(response.results[0].template.collection.collection_name).to.equal(collection_name);
            });
        });

        context('with search filter', () => {
            txit('gets the templates sales and volume even if they dont have sales', async () => {
                await client.createContractReader();

                await client.createToken({token_symbol: 'TOKEN1'});
                const context = getTestContext(client);
                // Included
                const {template_id} = await client.createTemplate({immutable_data: {name: 'test'}});
                // Not included
                await client.createTemplate();

                await client.refreshStatsMarket();

                const response = await getTemplateStatsAction({symbol: 'TOKEN1', search: 'test'}, context);

                expect(response.results.length).to.equal(1);
                expect(response.results[0]).to.deep.contains({
                    volume: '0', sales: '0',
                });
                expect(response.results[0].template.template_id).to.equal(template_id);
            });
        });

        context('with time after and before filter', () => {
            txit('gets the templates sales and volume even if they dont have sales in the period defined', async () => {
                await client.createContractReader();

                await client.createToken({token_symbol: 'TOKEN1'});
                // Included
                const {template_id} = await client.createTemplate();
                // Not included
                const {template_id: template_id2} = await client.createTemplate();

                const now = Date.now();

                const context = getTestContext(client);

                // Included
                await client.createFullSale({
                    final_price: 1,
                    listing_price: 1, listing_symbol: 'TOKEN1',
                    settlement_symbol: 'TOKEN1', state: SaleApiState.SOLD,
                    updated_at_time: now,
                    taker_marketplace: 'X',
                }, {template_id});

                // Not included
                await client.createFullSale({
                    final_price: 1,
                    listing_price: 1,
                    listing_symbol: 'TOKEN1',
                    settlement_symbol: 'TOKEN1',
                    state: SaleApiState.SOLD,
                    updated_at_time: now - 20,
                    taker_marketplace: 'X',
                }, {template_id: template_id2});

                // Not included
                await client.createFullSale({
                    final_price: 1,
                    listing_price: 1,
                    listing_symbol: 'TOKEN1',
                    settlement_symbol: 'TOKEN1',
                    state: SaleApiState.SOLD,
                    updated_at_time: now + 20,
                    taker_marketplace: 'X',
                }, {template_id: template_id2});

                await client.refreshStatsMarket();

                const response = await getTemplateStatsAction({
                    symbol: 'TOKEN1',
                    before: (now + 10).toString(),
                    after: (now - 10).toString()
                }, context);

                expect(response.results.length).to.equal(2);
                const t1Result = response.results.find((t: { template: { template_id: string} }) => t.template.template_id === template_id);
                const t2Result = response.results.find((t: { template: { template_id: string} }) => t.template.template_id === template_id2);

                expect(t1Result).to.deep.contains({
                    volume: '1', sales: '1',
                });

                expect(t2Result).to.deep.contains({
                    volume: '0', sales: '0',
                });
            });
        });
    });

    after(async () => await client.end());
});
