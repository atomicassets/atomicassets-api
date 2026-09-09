import 'mocha';
import { expect } from 'chai';
import { RequestValues } from '../../utils';
import { initAtomicAssetsTest } from '../test';
import { getTestContext } from '../../../../utils/test';
import { getTemplatesAction } from './templates';

const {client, txit} = initAtomicAssetsTest();

async function getTemplateIds(values: RequestValues): Promise<string[]> {
    const testContext = getTestContext(client);

    const templates = await getTemplatesAction(values, testContext);

    return templates.map((template: any) => template.template_id);
}

describe('AtomicAssets Templates API', () => {

    describe('getTemplatesAction', () => {

        txit('works without filters', async () => {
            const {template_id} = await client.createTemplate();

            expect(await getTemplateIds({}))
                .to.deep.equal([template_id]);
        });

        txit('filters by an immutable template attribute', async () => {
            await client.createTemplate();

            const {template_id} = await client.createTemplate({immutable_data: JSON.stringify({rarity: 'common'})});

            expect(await getTemplateIds({'template_data.rarity': 'common'}))
                .to.deep.equal([template_id]);
        });

        // A collection is free to keep an attribute on the mutable side, so the
        // template data filters read both data columns and such an attribute
        // stays reachable.
        txit('filters by a mutable template attribute', async () => {
            await client.createTemplate();

            const {template_id} = await client.createTemplate({mutable_data: JSON.stringify({lore: 'origin'})});

            expect(await getTemplateIds({'template_data.lore': 'origin'}))
                .to.deep.equal([template_id]);
        });

        txit('filters by a mutable template attribute through the data prefix', async () => {
            await client.createTemplate();

            const {template_id} = await client.createTemplate({mutable_data: JSON.stringify({weight: '80'})});

            expect(await getTemplateIds({'data:text.weight': '80'}))
                .to.deep.equal([template_id]);
        });

        // One containment test over a single column would return nothing here.
        txit('filters by pairs split across both data columns', async () => {
            await client.createTemplate({immutable_data: JSON.stringify({rarity: 'common'})});
            await client.createTemplate({mutable_data: JSON.stringify({lore: 'origin'})});

            const {template_id} = await client.createTemplate({
                immutable_data: JSON.stringify({rarity: 'common'}),
                mutable_data: JSON.stringify({lore: 'origin'}),
            });

            expect(await getTemplateIds({'template_data.rarity': 'common', 'template_data.lore': 'origin'}))
                .to.deep.equal([template_id]);
        });

        txit('matches an immutable template name', async () => {
            await client.createTemplate();

            const {template_id} = await client.createTemplate({immutable_data: JSON.stringify({name: 'prefix_par%_tial_postfix'})});

            expect(await getTemplateIds({match: 'par%_tial'}))
                .to.deep.equal([template_id]);
        });

        txit('matches a mutable template name', async () => {
            await client.createTemplate();

            const {template_id} = await client.createTemplate({mutable_data: JSON.stringify({name: 'prefix_par%_tial_postfix'})});

            expect(await getTemplateIds({match: 'par%_tial'}))
                .to.deep.equal([template_id]);
        });

        txit('searches a mutable template name', async () => {
            await client.createTemplate();

            const {template_id} = await client.createTemplate({mutable_data: JSON.stringify({name: 'prefix_par%_tial_postfix'})});

            expect(await getTemplateIds({search: 'par%_tial'}))
                .to.deep.equal([template_id]);
        });

        txit('counts the templates a mutable attribute selects', async () => {
            await client.createTemplate();

            await client.createTemplate({mutable_data: JSON.stringify({lore: 'origin'})});

            expect(await getTemplatesAction({'template_data.lore': 'origin', count: 'true'}, getTestContext(client)))
                .to.equal('1');
        });

        // The sort key merges the same two columns formatTemplate merges, so a
        // template that names itself mutably orders on the name the listing
        // reports for it rather than with the templates that have no name.
        txit('orders by name when the name comes from the mutable data', async () => {
            const {template_id: template_id1} = await client.createTemplate({mutable_data: JSON.stringify({name: 'A'})});
            const {template_id: template_id2} = await client.createTemplate({immutable_data: JSON.stringify({name: 'Z'})});

            expect(await getTemplateIds({sort: 'name', order: 'asc'}))
                .to.deep.equal([template_id1, template_id2]);

            const [template] = await getTemplatesAction(
                {sort: 'name', order: 'asc'}, getTestContext(client)
            );

            expect(template.name).to.equal('A');
        });

        txit('reports the mutable data and the merged data on the template itself', async () => {
            await client.createTemplate({
                immutable_data: JSON.stringify({name: 'TheName', rarity: 'common'}),
                mutable_data: JSON.stringify({weight: '80', rarity: 'stale'}),
            });

            const [template] = await getTemplatesAction({}, getTestContext(client));

            expect(template.mutable_data).to.deep.equal({weight: '80', rarity: 'stale'});
            expect(template.data).to.deep.equal({name: 'TheName', rarity: 'common', weight: '80'});
        });
    });

    after(async () => {
        await client.end();
    });
});
