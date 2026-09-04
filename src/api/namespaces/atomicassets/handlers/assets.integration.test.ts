import 'mocha';
import { expect } from 'chai';
import { RequestValues } from '../../utils';
import { initAtomicAssetsTest } from '../test';
import { getTestContext } from '../../../../utils/test';
import { getRawAssetsAction } from './assets';
import { fillAssets } from '../filler';
import { formatAsset } from '../format';

const {client, txit} = initAtomicAssetsTest();

async function getAssetIds(values: RequestValues): Promise<Array<number> | string> {
    const testContext = getTestContext(client);

    return await getRawAssetsAction(values, testContext);
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

            const result = await getAssetIds({ids: `${asset_id}`, count: 'true'});

            expect(result).to.equal('1');
        });

        txit('count + sort=name skips the templates JOIN', async () => {
            // Regression guard: getRawAssetsAction's `needsTemplateJoin`
            // forces the LEFT JOIN to atomicassets_templates when
            // sort === 'name', but count requests short-circuit before
            // any ORDER BY is applied - so the JOIN is pure overhead on
            // the count path. Production observed the count plan drop
            // from ~11.5M to ~2.7M rows when the JOIN was removed.
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

            const result = await getRawAssetsAction(
                {count: 'true', sort: 'name'},
                ctx,
            );

            expect(result).to.equal('2');
            expect(
                observedQueries.some(q => /LEFT JOIN atomicassets_templates/i.test(q)),
                'count requests must not JOIN atomicassets_templates even when sort=name',
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

    after(async () => {
        await client.end();
    });
});
