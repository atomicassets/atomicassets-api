import 'mocha';
import { expect } from 'chai';

import { initAtomicAssetsTest } from '../test';
import { getTestContext } from '../../../../utils/test';
import { getAssetLogsAction } from './assets';
import { getCollectionLogsAction } from './collections';
import { getSchemaLogsAction } from './schemas';
import { getTemplateLogsAction } from './templates';

// The v2.0.0 contract added mutable templates, schema media types, author
// succession and the RAM payer log. The filler records every one of those
// traces, but each per-entity /logs endpoint filters contract_traces by a
// fixed action list, so an action missing from that list is stored and never
// served. These tests cover the API-side action lists only: they write the
// contract_traces rows directly, independent of the filler pipeline that
// populates them in production.
const { client, txit } = initAtomicAssetsTest();

const CONTRACT = 'aatest';

describe('AtomicAssets v2 log entries', () => {

    txit('/v1/templates/{collection}/{id}/logs includes the mutable-template actions', async () => {
        const { collection_name, template_id } = await client.createTemplate();

        for (const name of ['deltemplate', 'redtemplmax', 'logsetdatatl']) {
            await client.createContractTrace({
                account: CONTRACT,
                name,
                metadata: { collection_name, template_id: Number(template_id), authorized_editor: 'editor' },
            });
        }

        const result = await getTemplateLogsAction({}, getTestContext(client, { collection_name, template_id }));

        expect(result.map((log: any) => log.name))
            .to.have.members(['deltemplate', 'redtemplmax', 'logsetdatatl']);
    });

    txit('/v1/collections/{collection}/logs includes the author-swap actions', async () => {
        const { collection_name } = await client.createCollection();

        for (const name of ['createauswap', 'acceptauswap', 'rejectauswap']) {
            await client.createContractTrace({
                account: CONTRACT,
                name,
                metadata: { collection_name, new_author: 'newauthor' },
            });
        }

        const result = await getCollectionLogsAction({}, getTestContext(client, { collection_name }));

        expect(result.map((log: any) => log.name))
            .to.have.members(['createauswap', 'acceptauswap', 'rejectauswap']);
    });

    txit('/v1/schemas/{collection}/{schema}/logs includes setschematyp', async () => {
        const { collection_name, schema_name } = await client.createSchema();

        await client.createContractTrace({
            account: CONTRACT,
            name: 'setschematyp',
            metadata: { collection_name, schema_name, authorized_editor: 'editor' },
        });

        const result = await getSchemaLogsAction({}, getTestContext(client, { collection_name, schema_name }));

        expect(result.map((log: any) => log.name)).to.include('setschematyp');
    });

    txit('/v1/assets/{id}/logs includes logrampayer', async () => {
        const { asset_id } = await client.createAsset();

        await client.createContractTrace({
            account: CONTRACT,
            name: 'logrampayer',
            metadata: {
                asset_id: String(asset_id),
                asset_owner: 'assetowner',
                old_ram_payer: 'oldpayer',
                new_ram_payer: 'newpayer',
            },
        });

        const result = await getAssetLogsAction({}, getTestContext(client, { asset_id }));

        expect(result.map((log: any) => log.name)).to.include('logrampayer');
    });

    txit('the greylist parameters narrow the extended action list', async () => {
        const { collection_name, schema_name } = await client.createSchema();

        for (const name of ['createschema', 'setschematyp']) {
            await client.createContractTrace({
                account: CONTRACT,
                name,
                metadata: { collection_name, schema_name },
            });
        }

        const context = getTestContext(client, { collection_name, schema_name });

        const blacklisted = await getSchemaLogsAction({ action_blacklist: 'setschematyp' }, context);
        expect(blacklisted.map((log: any) => log.name)).to.deep.equal(['createschema']);

        const whitelisted = await getSchemaLogsAction({ action_whitelist: 'setschematyp' }, context);
        expect(whitelisted.map((log: any) => log.name)).to.deep.equal(['setschematyp']);
    });

    after(async () => {
        await client.end();
    });
});
