import 'mocha';
import * as fs from 'fs';
import { expect } from 'chai';
import { RequestValues } from '../../utils';
import { initAtomicAssetsTest } from '../test';
import { getTestContext } from '../../../../utils/test';
import { getAssetStatsAction, getRawAssetsAction } from './assets';
import AtomicAssetsHandler from '../../../../filler/handlers/atomicassets';
import { ApiError } from '../../../error';
import { fillAssets } from '../filler';
import { formatAsset } from '../format';

const {client, txit} = initAtomicAssetsTest();

async function getAssetIds(values: RequestValues): Promise<Array<number> | string> {
    const testContext = getTestContext(client);

    return await getRawAssetsAction(values, testContext);
}

async function getAssetCount(values: RequestValues): Promise<string> {
    const testContext = getTestContext(client);

    return await getRawAssetsAction({...values, count: 'true'}, testContext) as string;
}

describe('AtomicAssets Assets API', () => {

    describe('getRawAssetsAction V1', () => {

        txit('works without filters', async () => {

            const {asset_id} = await client.createAsset();

            expect(await getAssetIds({}))
                .to.deep.equal([asset_id]);
        });

        txit('filters by authorized collection account', async () => {
            await client.createAsset();

            const {collection_name} = await client.createCollection({authorized_accounts: ['z']});
            const {asset_id} = await client.createAsset({collection_name});

            expect(await getAssetIds({authorized_account: 'z'}))
                .to.deep.equal([asset_id]);
        });

        txit('filters by hiding template accounts', async () => {
            const {asset_id} = await client.createAsset();

            const {template_id} = await client.createTemplate();
            await client.createAsset({template_id, owner: 'x'});
            await client.createAsset({template_id});

            expect(await getAssetIds({hide_templates_by_accounts: 'x'}))
                .to.deep.equal([asset_id]);
        });

        txit('filters by duplicate templates for the same owner', async () => {
            await client.createAsset();

            const {template_id} = await client.createTemplate();
            await client.createAsset({template_id});
            const {asset_id} = await client.createAsset({template_id});

            expect(await getAssetIds({only_duplicate_templates: 'true'}))
                .to.deep.equal([asset_id]);
        });

        txit('filters by having backed tokens', async () => {
            await client.createAsset();

            const {asset_id} = await client.createAsset();
            await client.createAssetBackedToken({asset_id});

            expect(await getAssetIds({has_backed_tokens: 'true'}))
                .to.deep.equal([asset_id]);
        });

        txit('filters by not having backed tokens', async () => {
            const {asset_id: asset_id2} = await client.createAsset();
            await client.createAssetBackedToken({asset_id: asset_id2});

            const {asset_id} = await client.createAsset();

            expect(await getAssetIds({has_backed_tokens: 'false'}))
                .to.deep.equal([asset_id]);
        });

        txit('filters by excluding offers', async () => {
            const {asset_id: asset_id2} = await client.createAsset();
            await client.createOfferAsset({asset_id: asset_id2});

            const {asset_id} = await client.createAsset();

            expect(await getAssetIds({hide_offers: 'true'}))
                .to.deep.equal([asset_id]);
        });

        txit('filters by template mint', async () => {
            await client.createAsset();

            const {asset_id} = await client.createAsset({
                template_mint: 3,
                template_id: (await client.createTemplate()).template_id,
            });

            expect(await getAssetIds({template_mint: '3'}))
                .to.deep.equal([asset_id]);
        });

        txit('filters by minimum template mint', async () => {
            await client.createAsset();

            const {asset_id} = await client.createAsset({
                template_mint: 3,
                template_id: (await client.createTemplate()).template_id,
            });

            expect(await getAssetIds({min_template_mint: '2'}))
                .to.deep.equal([asset_id]);
        });

        txit('filters by minimum template mint (treating no template as 1)', async () => {
            const {asset_id: asset_id2} = await client.createAsset();

            const {asset_id} = await client.createAsset({
                template_mint: 3,
                template_id: (await client.createTemplate()).template_id,
            });

            expect(await getAssetIds({min_template_mint: '1'}))
                .to.deep.equal([asset_id, asset_id2]);
        });

        txit('filters by maximum template mint', async () => {
            await client.createAsset({
                template_mint: 4,
                template_id: (await client.createTemplate()).template_id,
            });

            // includes assets without template
            const {asset_id: asset_id2} = await client.createAsset();

            const {asset_id} = await client.createAsset({
                template_mint: 3,
                template_id: (await client.createTemplate()).template_id,
            });

            expect(await getAssetIds({max_template_mint: '3'}))
                .to.deep.equal([asset_id, asset_id2]);
        });

        txit('filters by template blacklist', async () => {
            const {template_id} = await client.createTemplate();
            await client.createAsset({template_id});

            const {asset_id} = await client.createAsset({
                template_id: (await client.createTemplate()).template_id,
            });

            // assets without template should not be filtered out
            const {asset_id: asset_id2} = await client.createAsset();

            expect(await getAssetIds({template_blacklist: `${template_id},-1`}))
                .to.deep.equal([asset_id2, asset_id]);
        });

        txit('filters by template whitelist', async () => {
            await client.createAsset();

            const {template_id} = await client.createTemplate();
            const {asset_id} = await client.createAsset({template_id});

            expect(await getAssetIds({template_whitelist: `${template_id},-1`}))
                .to.deep.equal([asset_id]);
        });

        txit('filters by asset_id', async () => {
            await client.createAsset();

            const {asset_id} = await client.createAsset();

            expect(await getAssetIds({asset_id: `${asset_id},-1`}))
                .to.deep.equal([asset_id]);
        });

        txit('filters by owner', async () => {
            await client.createAsset();

            const {asset_id} = await client.createAsset({owner: 'x'});

            expect(await getAssetIds({owner: 'x'}))
                .to.deep.equal([asset_id]);
        });

        txit('filters by template', async () => {
            await client.createAsset();

            const {template_id} = await client.createTemplate();
            const {asset_id} = await client.createAsset({template_id});

            expect(await getAssetIds({template_id: `${template_id},-1`}))
                .to.deep.equal([asset_id]);
        });

        txit('filters by not having a template', async () => {
            const {template_id} = await client.createTemplate();
            await client.createAsset({template_id});

            const {asset_id} = await client.createAsset();

            expect(await getAssetIds({template_id: 'null'}))
                .to.deep.equal([asset_id]);
        });

        txit('filters by collection name', async () => {
            await client.createAsset();

            const {collection_name} = await client.createCollection({collection_name: 'x'});
            const {asset_id} = await client.createAsset({collection_name});

            expect(await getAssetIds({collection_name: 'x,abc'}))
                .to.deep.equal([asset_id]);
        });

        txit('filters by schema name', async () => {
            await client.createAsset();

            const {asset_id, schema_name} = await client.createAsset();

            expect(await getAssetIds({schema_name: `${schema_name},abc`}))
                .to.deep.equal([asset_id]);
        });

        txit('filters by being burned', async () => {
            await client.createAsset();

            const {asset_id} = await client.createAsset({owner: null});

            expect(await getAssetIds({burned: 'true'}))
                .to.deep.equal([asset_id]);
        });

        txit('filters by not being burned', async () => {
            await client.createAsset({owner: null});

            const {asset_id} = await client.createAsset({owner: 'x'});

            expect(await getAssetIds({burned: 'false'}))
                .to.deep.equal([asset_id]);
        });

        txit('filters by being transferable', async () => {
            await client.createAsset({
                template_id: (await client.createTemplate({transferable: false})).template_id,
            });

            const {asset_id} = await client.createAsset({
                template_id: (await client.createTemplate({transferable: true})).template_id,
            });

            expect(await getAssetIds({is_transferable: 'true'}))
                .to.deep.equal([asset_id]);
        });

        txit('filters by not being transferable', async () => {
            await client.createAsset({
                template_id: (await client.createTemplate({transferable: true})).template_id,
            });

            const {asset_id} = await client.createAsset({
                template_id: (await client.createTemplate({transferable: false})).template_id,
            });

            expect(await getAssetIds({is_transferable: 'false'}))
                .to.deep.equal([asset_id]);
        });

        txit('filters by being burnable', async () => {
            await client.createAsset({
                template_id: (await client.createTemplate({burnable: false})).template_id,
            });

            const {asset_id} = await client.createAsset({
                template_id: (await client.createTemplate({burnable: true})).template_id,
            });

            expect(await getAssetIds({is_burnable: 'true'}))
                .to.deep.equal([asset_id]);
        });

        txit('filters by not being burnable', async () => {
            await client.createAsset({
                template_id: (await client.createTemplate({burnable: true})).template_id,
            });

            const {asset_id} = await client.createAsset({
                template_id: (await client.createTemplate({burnable: false})).template_id,
            });

            expect(await getAssetIds({is_burnable: 'false'}))
                .to.deep.equal([asset_id]);
        });

        txit('filters by collection blacklist', async () => {
            const {collection_name} = await client.createCollection({collection_name: 'x'});
            await client.createAsset({collection_name});

            const {asset_id} = await client.createAsset();

            expect(await getAssetIds({collection_blacklist: 'x,abc'}))
                .to.deep.equal([asset_id]);
        });

        txit('filters by collection whitelist', async () => {
            await client.createAsset();

            const {collection_name} = await client.createCollection({collection_name: 'x'});
            const {asset_id} = await client.createAsset({collection_name});

            expect(await getAssetIds({collection_whitelist: 'x,abc'}))
                .to.deep.equal([asset_id]);
        });

        txit('filters by text data', async () => {
            await client.createAsset();

            const {template_id} = await client.createTemplate({immutable_data: JSON.stringify({'prop': 'TheValue'})});
            const {asset_id} = await client.createAsset({template_id});

            expect(await getAssetIds({'data:text.prop': 'TheValue'}))
                .to.deep.equal([asset_id]);
        });

        txit('filters by number template_data', async () => {
            await client.createAsset();

            const {template_id} = await client.createTemplate({immutable_data: JSON.stringify({'prop': 1})});
            const {asset_id} = await client.createAsset({template_id});

            expect(await getAssetIds({'template_data:number.prop': 1}))
                .to.deep.equal([asset_id]);
        });

        txit('filters by number data on a float template attribute', async () => {
            await client.createAsset();

            // A float attribute is stored as a JSON number, so data:number.<key>
            // is the filter that reaches it. data:text.<key> read the string form
            // the 1.x decoder wrote and no longer matches.
            const {template_id} = await client.createTemplate({immutable_data: JSON.stringify({wear: 0.75})});
            const {asset_id} = await client.createAsset({template_id});

            expect(await getAssetIds({'data:number.wear': 0.75}))
                .to.deep.equal([asset_id]);

            expect(await getAssetIds({'data:text.wear': '0.75'}))
                .to.deep.equal([]);
        });

        txit('filters by number mutable_data on a float attribute', async () => {
            await client.createAsset();

            const {asset_id} = await client.createAsset({mutable_data: JSON.stringify({wear: 0.75})});

            expect(await getAssetIds({'mutable_data:number.wear': 0.75}))
                .to.deep.equal([asset_id]);

            const row = await client.fetchOne(
                'SELECT mutable_data, jsonb_typeof(mutable_data -> \'wear\') AS wear_type ' +
                'FROM atomicassets_assets WHERE asset_id = $1',
                [asset_id]
            );
            expect(row.wear_type).to.equal('number');
            expect(row.mutable_data).to.deep.equal({wear: 0.75});
        });

        txit('filters by bool mutable_data', async () => {
            await client.createAsset();

            const {asset_id} = await client.createAsset({mutable_data: JSON.stringify({'prop': 1})});

            expect(await getAssetIds({'mutable_data:bool.prop': 'true'}))
                .to.deep.equal([asset_id]);
        });

        txit('filters by untyped immutable_data', async () => {
            await client.createAsset();

            const {asset_id} = await client.createAsset({immutable_data: JSON.stringify({'prop': 'this'})});

            expect(await getAssetIds({'immutable_data.prop': 'this'}))
                .to.deep.equal([asset_id]);
        });

        txit('filters by match_immutable_name', async () => {
            await client.createAsset();

            const {asset_id} = await client.createAsset({immutable_data: JSON.stringify({name: 'prefix_par%_tial_postfix'})});

            expect(await getAssetIds({'match_immutable_name': 'par%_tial'}))
                .to.deep.equal([asset_id]);
        });

        txit('filters by match_mutable_name', async () => {
            await client.createAsset();

            const {asset_id} = await client.createAsset({mutable_data: JSON.stringify({name: 'prefix_par%_tial_postfix'})});

            expect(await getAssetIds({'match_mutable_name': 'par%_tial'}))
                .to.deep.equal([asset_id]);
        });

        txit('filters by match (template name)', async () => {
            await client.createAsset();

            const {template_id} = await client.createTemplate({immutable_data: JSON.stringify({name: 'prefix_par%_tial_postfix'})});
            const {asset_id} = await client.createAsset({template_id});

            expect(await getAssetIds({'match': 'par%_tial'}))
                .to.deep.equal([asset_id]);
        });

        txit('filters by search (template name)', async () => {
            await client.createAsset();

            const {template_id} = await client.createTemplate({immutable_data: JSON.stringify({name: 'prefix_par%_tial_postfix'})});
            const {asset_id} = await client.createAsset({template_id});

            expect(await getAssetIds({'search': 'par%_tial'}))
                .to.deep.equal([asset_id]);
        });

        // A collection is free to keep an attribute on the template's mutable
        // side, so the template data filters read both template data columns
        // and such an attribute stays reachable.
        txit('filters by template_data on a mutable template attribute', async () => {
            await client.createAsset();

            const {template_id} = await client.createTemplate({mutable_data: JSON.stringify({lore: 'origin'})});
            const {asset_id} = await client.createAsset({template_id});

            expect(await getAssetIds({'template_data.lore': 'origin'}))
                .to.deep.equal([asset_id]);
        });

        txit('filters by data on a mutable template attribute', async () => {
            await client.createAsset();

            const {template_id} = await client.createTemplate({mutable_data: JSON.stringify({weight: '80'})});
            const {asset_id} = await client.createAsset({template_id});

            expect(await getAssetIds({'data:text.weight': '80'}))
                .to.deep.equal([asset_id]);
        });

        txit('filters by template_data pairs split across both template columns', async () => {
            await client.createAsset();

            const {template_id} = await client.createTemplate({
                immutable_data: JSON.stringify({rarity: 'common'}),
                mutable_data: JSON.stringify({lore: 'origin'}),
            });
            const {asset_id} = await client.createAsset({template_id});

            expect(await getAssetIds({'template_data.rarity': 'common', 'template_data.lore': 'origin'}))
                .to.deep.equal([asset_id]);
        });

        txit('filters by match (mutable template name)', async () => {
            await client.createAsset();

            const {template_id} = await client.createTemplate({mutable_data: JSON.stringify({name: 'prefix_par%_tial_postfix'})});
            const {asset_id} = await client.createAsset({template_id});

            expect(await getAssetIds({'match': 'par%_tial'}))
                .to.deep.equal([asset_id]);
        });

        txit('filters by search (mutable template name)', async () => {
            await client.createAsset();

            const {template_id} = await client.createTemplate({mutable_data: JSON.stringify({name: 'prefix_par%_tial_postfix'})});
            const {asset_id} = await client.createAsset({template_id});

            expect(await getAssetIds({'search': 'par%_tial'}))
                .to.deep.equal([asset_id]);
        });

        // The asset's own mutable_data filter reads the asset columns only and
        // must stay clear of the template columns the branch above now reads.
        txit('filters by untyped mutable_data on the asset alone', async () => {
            const {template_id} = await client.createTemplate({mutable_data: JSON.stringify({prop: 'this'})});
            await client.createAsset({template_id});

            const {asset_id} = await client.createAsset({mutable_data: JSON.stringify({prop: 'this'})});

            expect(await getAssetIds({'mutable_data.prop': 'this'}))
                .to.deep.equal([asset_id]);
        });

        txit('returns count', async () => {
            await client.createAsset();

            const {asset_id} = await client.createAsset();

            const result = await getAssetCount({ids: `${asset_id}`});

            expect(result).to.equal('1');
        });

        txit('returns count from aggregate table without filters', async () => {
            await client.createAsset({owner: null});
            await client.createAsset();

            expect(await getAssetCount({})).to.equal('2');
        });

        txit('returns count from aggregate table for burned filter', async () => {
            await client.createAsset({owner: null});
            await client.createAsset();

            expect(await getAssetCount({burned: 'true'})).to.equal('1');
            expect(await getAssetCount({burned: 'false'})).to.equal('1');
        });

        txit('returns count from aggregate table for collection and template filters', async () => {
            const {collection_name} = await client.createCollection({collection_name: 'x'});
            const {template_id} = await client.createTemplate({collection_name});

            await client.createAsset({collection_name, template_id});
            await client.createAsset({collection_name});
            await client.createAsset();

            expect(await getAssetCount({collection_name})).to.equal('2');
            expect(await getAssetCount({template_id})).to.equal('1');
            expect(await getAssetCount({template_id: 'null'})).to.equal('2');
        });

        txit('falls back to raw count for owner filter', async () => {
            await client.createAsset({owner: 'alice'});
            await client.createAsset({owner: 'bob'});

            expect(await getAssetCount({owner: 'alice'})).to.equal('1');
        });

        txit('count + sort=name uses the aggregate table and skips the templates JOIN', async () => {
            // Fast path: unfiltered counts read atomicassets_asset_counts.
            // sort=name does not consume a template column on the count
            // path, so the templates JOIN stays off (same gate as the
            // raw COUNT(*) fallback).
            await client.createAsset();
            await client.createAsset();

            const observedQueries: string[] = [];
            const recordingDb = {
                query: (text: string, values?: any[]) => {
                    observedQueries.push(text);
                    return client.query(text, values);
                },
                fetchOne: (text: string, values?: any[]) => {
                    observedQueries.push(text);
                    return client.fetchOne(text, values);
                },
            };
            const ctx = getTestContext(recordingDb as any);
            // The fast count path is opt-in, so this case asks for it explicitly.
            ctx.coreArgs.enable_fast_asset_counts = true;

            const result = await getRawAssetsAction(
                {count: 'true', sort: 'name'},
                ctx,
            );

            expect(result).to.equal('2');
            expect(
                observedQueries.some(q => /atomicassets_asset_counts/i.test(q)),
                'unfiltered count must use atomicassets_asset_counts',
            ).to.equal(true);
            expect(
                observedQueries.some(q => /FROM atomicassets_assets/i.test(q)),
                'unfiltered count must not scan atomicassets_assets',
            ).to.equal(false);
            expect(
                observedQueries.some(q => /LEFT JOIN atomicassets_templates/i.test(q)),
                'count requests must not JOIN atomicassets_templates even when sort=name',
            ).to.equal(false);
        });

        txit('count + owner + sort=name skips the templates JOIN on the raw fallback', async () => {
            // owner is not a fast-count key, so we COUNT(*) over assets.
            // sort=name still must not pull in the templates JOIN.
            await client.createAsset({owner: 'alice'});
            await client.createAsset({owner: 'bob'});

            const observedQueries: string[] = [];
            const recordingDb = {
                query: (text: string, values?: any[]) => {
                    observedQueries.push(text);
                    return client.query(text, values);
                },
                fetchOne: (text: string, values?: any[]) => {
                    observedQueries.push(text);
                    return client.fetchOne(text, values);
                },
            };
            const ctx = getTestContext(recordingDb as any);

            const result = await getRawAssetsAction(
                {count: 'true', sort: 'name', owner: 'alice'},
                ctx,
            );

            expect(result).to.equal('1');
            expect(
                observedQueries.some(q => /SELECT COUNT\(\*\)/i.test(q)),
                'owner count must fall back to raw COUNT(*)',
            ).to.equal(true);
            expect(
                observedQueries.some(q => /LEFT JOIN atomicassets_templates/i.test(q)),
                'raw count fallback must not JOIN atomicassets_templates even when sort=name',
            ).to.equal(false);
        });

        txit('non-count sort=name keeps the templates JOIN', async () => {
            // Complementary guard for the above: when count is NOT set,
            // sort === 'name' DOES need the JOIN because the ORDER BY
            // clause reads `template.immutable_data`. Drops the gate too
            // aggressively → name sort returns wrong order or crashes.
            await client.createAsset();

            const observedQueries: string[] = [];
            const recordingDb = {
                query: (text: string, values?: any[]) => {
                    observedQueries.push(text);
                    return client.query(text, values);
                },
                fetchOne: (text: string, values?: any[]) => {
                    observedQueries.push(text);
                    return client.fetchOne(text, values);
                },
            };
            const ctx = getTestContext(recordingDb as any);

            await getRawAssetsAction({sort: 'name'}, ctx);

            expect(
                observedQueries.some(q => /LEFT JOIN atomicassets_templates/i.test(q)),
                'non-count sort=name must JOIN atomicassets_templates for ORDER BY',
            ).to.equal(true);
        });

        txit('orders ascending', async () => {
            const {asset_id: asset_id1} = await client.createAsset();

            const {asset_id: asset_id2} = await client.createAsset();

            expect(await getAssetIds({order: 'asc'}))
                .to.deep.equal([asset_id1, asset_id2]);
        });

        txit('orders descending', async () => {
            const {asset_id: asset_id1} = await client.createAsset();

            const {asset_id: asset_id2} = await client.createAsset();

            expect(await getAssetIds({order: 'desc'}))
                .to.deep.equal([asset_id2, asset_id1]);
        });

        txit('orders by asset_id', async () => {
            const asset_id2 = `${client.getId()}`;
            const {asset_id: asset_id1} = await client.createAsset();

            await client.createAsset({asset_id: asset_id2});

            expect(await getAssetIds({sort: 'asset_id'}))
                .to.deep.equal([asset_id1, asset_id2]);
        });

        txit('orders by updated time', async () => {
            const updated_at_time = `${client.getId()}`;
            const {asset_id: asset_id1} = await client.createAsset();

            const {asset_id: asset_id2} = await client.createAsset({updated_at_time});

            expect(await getAssetIds({sort: 'updated'}))
                .to.deep.equal([asset_id1, asset_id2]);
        });

        txit('orders by transferred time', async () => {
            const transferred_at_time = `${client.getId()}`;
            const {asset_id: asset_id1} = await client.createAsset();

            const {asset_id: asset_id2} = await client.createAsset({transferred_at_time});

            expect(await getAssetIds({sort: 'transferred'}))
                .to.deep.equal([asset_id1, asset_id2]);
        });

        txit('orders by minted', async () => {
            const asset_id2 = `${client.getId()}`;
            const {asset_id: asset_id1} = await client.createAsset();

            await client.createAsset({asset_id: asset_id2});

            expect(await getAssetIds({sort: 'minted'}))
                .to.deep.equal([asset_id1, asset_id2]);
        });

        txit('orders by template_mint', async () => {
            const {asset_id: asset_id1} = await client.createAsset({template_mint: 2});

            const {asset_id: asset_id2} = await client.createAsset({template_mint: 1});

            expect(await getAssetIds({sort: 'template_mint'}))
                .to.deep.equal([asset_id1, asset_id2]);
        });

        txit('orders by name', async () => {
            const {template_id: template_id1} = await client.createTemplate({immutable_data: JSON.stringify({name: 'B'})});
            const {asset_id: asset_id1} = await client.createAsset({template_id: template_id1});

            const {template_id: template_id2} = await client.createTemplate({immutable_data: JSON.stringify({name: 'A'})});
            const {asset_id: asset_id2} = await client.createAsset({template_id: template_id2});

            expect(await getAssetIds({sort: 'name'}))
                .to.deep.equal([asset_id1, asset_id2]);
        });

        // The sort key carries the same four layers formatAsset merges, so an
        // asset that takes its name from the template's mutable side sorts on
        // the name the response reports rather than on a null.
        txit('orders by name when the name comes from the template mutable data', async () => {
            const {template_id: template_id1} = await client.createTemplate({mutable_data: JSON.stringify({name: 'B'})});
            const {asset_id: asset_id1} = await client.createAsset({template_id: template_id1});

            const {template_id: template_id2} = await client.createTemplate({immutable_data: JSON.stringify({name: 'A'})});
            const {asset_id: asset_id2} = await client.createAsset({template_id: template_id2});

            expect(await getAssetIds({sort: 'name'}))
                .to.deep.equal([asset_id1, asset_id2]);

            const [asset] = await fillAssets(
                client, 'aatest', [asset_id1], formatAsset, 'atomicassets_assets_master'
            );

            expect(asset.name).to.equal('B');
        });

        txit('paginates', async () => {
            const {asset_id} = await client.createAsset();

            await client.createAsset();

            expect(await getAssetIds({page: '2', limit: '1'}))
                .to.deep.equal([asset_id]);
        });

        txit('filters by id (asset_id)', async () => {
            await client.createAsset();

            const {asset_id} = await client.createAsset();

            expect(await getAssetIds({ids: `${asset_id},-1`}))
                .to.deep.equal([asset_id]);
        });

        txit('filters by id range (asset_id)', async () => {
            await client.createAsset();

            const lower_bound = `${client.getId()}`;

            const {asset_id} = await client.createAsset();
            const upper_bound = `${client.getId()}`;

            await client.createAsset();

            expect(await getAssetIds({lower_bound, upper_bound}))
                .to.deep.equal([asset_id]);
        });

        txit('filters by date range', async () => {
            await client.createAsset();

            const after = `${client.getId()}`;

            const {asset_id} = await client.createAsset();
            const before = `${client.getId()}`;

            await client.createAsset();

            expect(await getAssetIds({after, before}))
                .to.deep.equal([asset_id]);
        });
    });

    // The nested template object of atomicassets_assets_master carries
    // mutable_data and both deletion marks, so an asset response reports the
    // template's mutable keys in the merged data and tells a deleted template
    // apart from a live one.
    describe('asset response template layer', () => {

        async function getAsset(assetId: string): Promise<any> {
            const [asset] = await fillAssets(
                client, 'aatest', [assetId], formatAsset, 'atomicassets_assets_master'
            );

            return asset;
        }

        txit('reports the template mutable data and the merged template layer', async () => {
            const {template_id} = await client.createTemplate({
                immutable_data: JSON.stringify({name: 'TheName', rarity: 'common'}),
                mutable_data: JSON.stringify({weight: '80', rarity: 'stale'}),
            });
            const {asset_id} = await client.createAsset({template_id});

            const asset = await getAsset(asset_id);

            expect(asset.template.mutable_data).to.deep.equal({weight: '80', rarity: 'stale'});
            expect(asset.template.immutable_data).to.deep.equal({name: 'TheName', rarity: 'common'});
            expect(asset.template.data).to.deep.equal({name: 'TheName', rarity: 'common', weight: '80'});
        });

        txit('merges the template mutable data into the asset data', async () => {
            const {template_id} = await client.createTemplate({
                immutable_data: JSON.stringify({name: 'TheName'}),
                mutable_data: JSON.stringify({weight: '80'}),
            });
            const {asset_id} = await client.createAsset({template_id});

            const asset = await getAsset(asset_id);

            expect(asset.data).to.deep.equal({name: 'TheName', weight: '80'});
            expect(asset.name).to.equal('TheName');
        });

        // The layer order the endpoint has always served: the template's
        // immutable values sit above the asset's own, and its mutable values
        // sit below them as the fallback the asset overrides.
        txit('keeps the asset data above the template mutable data and below the template immutable data', async () => {
            const {template_id} = await client.createTemplate({
                immutable_data: JSON.stringify({rarity: 'common'}),
                mutable_data: JSON.stringify({weight: '80'}),
            });
            const {asset_id} = await client.createAsset({
                template_id,
                immutable_data: JSON.stringify({weight: '10', rarity: 'rare'}),
            });

            const asset = await getAsset(asset_id);

            expect(asset.data.weight).to.equal('10');
            expect(asset.data.rarity).to.equal('common');
        });

        txit('reports no deletion marks for a live template', async () => {
            const {template_id} = await client.createTemplate();
            const {asset_id} = await client.createAsset({template_id});

            const asset = await getAsset(asset_id);

            expect(asset.template.deleted_at_time).to.equal(null);
            expect(asset.template.deleted_at_block).to.equal(null);
        });

        txit('carries a deleted template deletion marks into the asset response', async () => {
            const {template_id} = await client.createTemplate({
                deleted_at_block: 4711,
                deleted_at_time: 4712,
            });
            const {asset_id} = await client.createAsset({template_id});

            const asset = await getAsset(asset_id);

            expect(asset.template.deleted_at_block).to.equal('4711');
            expect(asset.template.deleted_at_time).to.equal('4712');
        });
    });

    describe('original mint', () => {

        const group = JSON.stringify(['cards', '7', 'a', '']);

        async function linkedAsset(original_mint: number | null, extra: Record<string, any> = {}): Promise<string> {
            const {asset_id} = await client.createAsset(extra);
            await client.createOriginalMint({asset_id, original_mint});

            return asset_id;
        }

        txit('filters by original mint', async () => {
            await linkedAsset(1);
            const wanted = await linkedAsset(2);
            await client.createAsset();

            expect(await getAssetIds({original_mint: '2'})).to.deep.equal([wanted]);
        });

        txit('filters by the original mint range', async () => {
            const {collection_name} = await client.createCollection();
            await linkedAsset(1, {collection_name});
            const second = await linkedAsset(2, {collection_name});
            const third = await linkedAsset(3, {collection_name});
            await linkedAsset(4, {collection_name});

            expect(await getAssetIds({collection_name, min_original_mint: '2', max_original_mint: '3', sort: 'original_mint', order: 'asc'}))
                .to.deep.equal([second, third]);
        });

        txit('filters by the minimum alone and by the maximum alone', async () => {
            const one = await linkedAsset(1);
            const two = await linkedAsset(2);
            await client.createAsset();

            expect(await getAssetIds({min_original_mint: '2'})).to.deep.equal([two]);
            expect(await getAssetIds({max_original_mint: '1'})).to.deep.equal([one]);
        });

        txit('does not match a link row of another contract', async () => {
            const {asset_id} = await client.createAsset();
            await client.createOriginalMint({asset_id, original_mint: 5, contract: 'other'});

            expect(await getAssetIds({original_mint: '5'})).to.deep.equal([]);
        });

        txit('sorts by original mint in both directions and lists only assets that have one', async () => {
            await client.createAsset();
            await linkedAsset(null);
            const three = await linkedAsset(3);
            const one = await linkedAsset(1);
            const two = await linkedAsset(2);

            expect(await getAssetIds({sort: 'original_mint', order: 'asc'})).to.deep.equal([one, two, three]);
            expect(await getAssetIds({sort: 'original_mint', order: 'desc'})).to.deep.equal([three, two, one]);
        });

        txit('orders equal original mints by asset id in both directions', async () => {
            const first = await linkedAsset(5);
            const second = await linkedAsset(5);
            const lower = await linkedAsset(4);

            expect(await getAssetIds({sort: 'original_mint', order: 'asc'})).to.deep.equal([lower, first, second]);
            expect(await getAssetIds({sort: 'original_mint', order: 'desc'})).to.deep.equal([first, second, lower]);
        });

        txit('counts the assets the original mint sort can return', async () => {
            await client.createAsset();
            await linkedAsset(null);
            await linkedAsset(1);
            await linkedAsset(2);

            const listed = await getAssetIds({sort: 'original_mint'}) as number[];

            expect(await getAssetCount({sort: 'original_mint'})).to.equal(String(listed.length));
            expect(listed.length).to.equal(2);
        });

        txit('counts by original mint', async () => {
            await linkedAsset(1);
            await linkedAsset(2);

            expect(await getAssetCount({min_original_mint: '2'})).to.equal('1');
        });

        txit('rejects an original mint below one', async () => {
            let error: any = null;

            try {
                await getAssetIds({original_mint: '0'});
            } catch (e) {
                error = e;
            }

            expect(error).to.be.instanceOf(ApiError);
            expect(error.code).to.equal(400);
            expect(error.message).to.contain('Invalid value for parameter original_mint');
        });

        txit('leaves the template mint filters on assets that have no link', async () => {
            const {asset_id} = await client.createAsset({
                template_mint: 3,
                template_id: (await client.createTemplate()).template_id,
            });

            expect(await getAssetIds({template_mint: '3'})).to.deep.equal([asset_id]);
        });

        describe('formatted asset', () => {

            async function getAsset(assetId: string): Promise<any> {
                const [asset] = await fillAssets(
                    client, 'aatest', [assetId], formatAsset, 'atomicassets_assets_master'
                );

                return asset;
            }

            txit('reports the original mint as a string', async () => {
                const asset_id = await linkedAsset(12);

                expect((await getAsset(asset_id)).original_mint).to.equal('12');
            });

            txit('reports null for an asset without a link', async () => {
                const {asset_id} = await client.createAsset();

                expect((await getAsset(asset_id)).original_mint).to.equal(null);
            });

            txit('reports null for a link whose source has no mint number', async () => {
                const asset_id = await linkedAsset(null);

                expect((await getAsset(asset_id)).original_mint).to.equal(null);
            });

            txit('keeps the template mint of the same asset a string', async () => {
                const {template_id} = await client.createTemplate();
                const {asset_id} = await client.createAsset({template_id, template_mint: 4});
                await client.createOriginalMint({asset_id, original_mint: 9});

                const asset = await getAsset(asset_id);

                expect(asset.template_mint).to.equal('4');
                expect(asset.original_mint).to.equal('9');
            });

            txit('adds original_mint as the last column of the master view', async () => {
                const {rows} = await client.query(
                    'SELECT attname FROM pg_attribute WHERE attrelid = \'atomicassets_assets_master\'::regclass ' +
                    'AND attnum > 0 AND NOT attisdropped ORDER BY attnum DESC LIMIT 1'
                );

                expect(rows[0].attname).to.equal('original_mint');
            });
        });

        describe('stats', () => {

            async function getStats(assetId: string): Promise<any> {
                return await getAssetStatsAction({}, getTestContext(client, {asset_id: assetId}));
            }

            async function seedGroup(): Promise<{original_asset_id: string}> {
                // Four creates in the group, one burned, one held by the bridge account.
                await client.createSimpleCardTotal({mint_group: group, total_ever: 6});
                const first = await client.createSimpleAsset({mint_group: group, mint_number: 1});
                await client.createSimpleAsset({mint_group: group, mint_number: 2, owner: 'bridge'});
                await client.createSimpleAsset({mint_group: group, mint_number: 3, owner: null});
                await client.createSimpleAsset({mint_group: group, mint_number: 4});
                // Same contract and author, another group, and another author with the same group.
                await client.createSimpleAsset({mint_group: JSON.stringify(['cards', '8', 'a', '']), mint_number: 1});
                await client.createSimpleAsset({mint_group: group, mint_number: 1, author: 'someoneelse'});

                return {original_asset_id: first.asset_id};
            }

            txit('reports the group totals for a linked asset as strings', async () => {
                const {original_asset_id} = await seedGroup();
                const {template_id} = await client.createTemplate();
                const {asset_id} = await client.createAsset({template_id});
                await client.createOriginalMint({asset_id, original_asset_id, original_mint: 1});

                const stats = await getStats(asset_id);

                expect(stats.original).to.deep.equal({mint: '1', total_ever: '6', circulation: '3', burned: '3'});
                expect(stats.template_mint).to.equal('1');
            });

            txit('never reports a negative burned count', async () => {
                const {original_asset_id} = await seedGroup();
                await client.query('UPDATE simpleassets_card_totals SET total_ever = 2');
                const {asset_id} = await client.createAsset();
                await client.createOriginalMint({asset_id, original_asset_id, original_mint: 1});

                expect((await getStats(asset_id)).original).to.deep.equal({mint: '1', total_ever: '2', circulation: '3', burned: '0'});
            });

            txit('reports original null for an asset without a link', async () => {
                await seedGroup();
                const {asset_id} = await client.createAsset();

                expect((await getStats(asset_id)).original).to.equal(null);
            });

            txit('reports original null when the source asset is not indexed', async () => {
                const {asset_id} = await client.createAsset();
                await client.createOriginalMint({asset_id, original_mint: 1});

                expect((await getStats(asset_id)).original).to.equal(null);
            });

            txit('reports original null when the link table does not exist', async () => {
                const {original_asset_id} = await seedGroup();
                const {asset_id} = await client.createAsset();
                await client.createOriginalMint({asset_id, original_asset_id, original_mint: 1});
                await client.query('DROP TABLE atomicassets_original_mints CASCADE');

                expect((await getStats(asset_id)).original).to.equal(null);
            });

            txit('reports original null when the simpleassets tables do not exist', async () => {
                const {original_asset_id} = await seedGroup();
                const {template_id} = await client.createTemplate();
                const {asset_id} = await client.createAsset({template_id});
                await client.createOriginalMint({asset_id, original_asset_id, original_mint: 1});
                await client.query('DROP TABLE simpleassets_card_totals, simpleassets_assets CASCADE');

                const stats = await getStats(asset_id);

                expect(stats.original).to.equal(null);
                expect(stats.template_mint).to.equal('1');
            });
        });
    });

    // Older upgrade branches apply the view shape that predates original_mint,
    // so a database coming from before the link table reaches 2.0.13 with a
    // view that CREATE OR REPLACE can extend.
    describe('master view upgrade', () => {

        async function columnCount(): Promise<number> {
            const {rows: [column]} = await client.query(
                'SELECT count(*)::int AS found FROM pg_attribute WHERE attrelid = \'atomicassets_assets_master\'::regclass ' +
                'AND attname = \'original_mint\''
            );

            return column.found;
        }

        txit('re-applies the view under a short lock timeout in the 2.0.13 branch', async () => {
            await client.query('DROP VIEW atomicassets_assets_master CASCADE');
            await client.query(fs.readFileSync('./definitions/views/atomicassets_assets_master.pre-original-mint.sql', {encoding: 'utf8'}));

            expect(await columnCount()).to.equal(0);

            await AtomicAssetsHandler.upgrade(client as any, '2.0.13');

            const {rows: [timeout]} = await client.query('SHOW lock_timeout');

            expect(timeout.lock_timeout).to.equal('5s');
            expect(await columnCount()).to.equal(1);
        });

        txit('adds the view column to a database that predates the link table', async () => {
            await client.query('DROP VIEW atomicassets_assets_master CASCADE');
            await client.query('DROP TABLE atomicassets_original_mints');

            await AtomicAssetsHandler.upgrade(client as any, '1.2.2');
            await AtomicAssetsHandler.upgrade(client as any, '1.3.20');
            await AtomicAssetsHandler.upgrade(client as any, '2.0.0');
            await client.query(fs.readFileSync('./definitions/migrations/2.0.12/atomicassets.sql', {encoding: 'utf8'}));
            await AtomicAssetsHandler.upgrade(client as any, '2.0.13');

            const {asset_id} = await client.createAsset();
            const [asset] = await fillAssets(client, 'aatest', [asset_id], formatAsset, 'atomicassets_assets_master');

            expect(asset.original_mint).to.equal(null);
        });

        // A database that took 2.0.12 without the handler has no link table
        // when the handler SQL of 2.0.13 runs ahead of the branch.
        txit('creates the link table from the 2.0.13 handler file ahead of the branch', async () => {
            await client.query('DROP VIEW atomicassets_assets_master CASCADE');
            await client.query('DROP TABLE atomicassets_original_mints');
            await client.query(fs.readFileSync('./definitions/views/atomicassets_assets_master.pre-original-mint.sql', {encoding: 'utf8'}));

            await client.query(fs.readFileSync('./definitions/migrations/2.0.13/atomicassets.sql', {encoding: 'utf8'}));
            await AtomicAssetsHandler.upgrade(client as any, '2.0.13');
            await client.query(fs.readFileSync('./definitions/migrations/2.0.13/atomicassets.sql', {encoding: 'utf8'}));

            expect(await columnCount()).to.equal(1);
        });
    });

    after(async () => {
        await client.end();
    });
});
