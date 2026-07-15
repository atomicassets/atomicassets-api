import 'mocha';
import { expect } from 'chai';
import { Client } from 'pg';
import { serialize, ObjectSchema } from 'atomicassets';
import { getTestPostgresConfig } from '../../../utils/test';
import { reconcileAtomicAssetsContract, ReconcileRpc } from './reconcile';

const CONTRACT = 'atomicassets';
const COLLECTION = 'reccol111111';
const SCHEMA = 'recschema111';
const HEAD_BLOCK = 999_000;

const SCHEMA_FORMAT = [
    { name: 'name', type: 'string' },
    { name: 'level', type: 'uint64' },
];

function serializeSchemaData(data: Record<string, any>): string {
    const schema = ObjectSchema(SCHEMA_FORMAT);
    return Buffer.from(serialize(data, schema)).toString('hex');
}

/** Builds a mock RPC pager that serves fixed rows for each (code, scope, table) and a fixed scope list per table - no live chain involved. */
function createMockRpc(options: {
    headBlockNum?: number;
    scopesByTable?: Record<string, string[]>;
    rowsByScope?: Record<string, Record<string, any[]>>; // table -> scope -> rows
}): ReconcileRpc {
    const scopesByTable = options.scopesByTable ?? {};
    const rowsByScope = options.rowsByScope ?? {};

    return {
        async get_info(): Promise<{ head_block_num: number }> {
            return { head_block_num: options.headBlockNum ?? HEAD_BLOCK };
        },
        async get_table_rows(params: any): Promise<{ rows: any[]; more: any }> {
            const rows = rowsByScope[params.table]?.[params.scope] ?? [];
            return { rows, more: false };
        },
        async get_table_by_scope(params: any): Promise<{ rows: Array<{ scope: string }>; more: any }> {
            const scopes = scopesByTable[params.table] ?? [];
            return { rows: scopes.map(scope => ({ scope })), more: false };
        },
    };
}

describe('reconcileAtomicAssetsContract', () => {
    let client: Client;

    before(async () => {
        client = new Client(getTestPostgresConfig());
        await client.connect();
    });

    after(async () => {
        await client.end();
    });

    beforeEach(async () => {
        await client.query('DELETE FROM atomicassets_templates WHERE contract = $1', [CONTRACT]);
        await client.query('DELETE FROM atomicassets_schemas WHERE contract = $1', [CONTRACT]);
        await client.query('DELETE FROM atomicassets_collections WHERE contract = $1', [CONTRACT]);
        await client.query('DELETE FROM atomicassets_config WHERE contract = $1', [CONTRACT]);

        await client.query(
            'INSERT INTO atomicassets_config (contract, version, collection_format, v2_marker_block) VALUES ($1, $2, ARRAY[]::jsonb[], NULL)',
            [CONTRACT, '1.3.25']
        );
        await client.query(
            'INSERT INTO atomicassets_collections (contract, collection_name, author, allow_notify, authorized_accounts, notify_accounts, market_fee, created_at_block, created_at_time) ' +
            'VALUES ($1, $2, $3, true, ARRAY[]::varchar[], ARRAY[]::varchar[], 0.05, 1, 1)',
            [CONTRACT, COLLECTION, 'creator11111']
        );
        await client.query(
            'INSERT INTO atomicassets_schemas (contract, collection_name, schema_name, format, created_at_block, created_at_time) ' +
            'VALUES ($1, $2, $3, $4, 1, 1)',
            [CONTRACT, COLLECTION, SCHEMA, SCHEMA_FORMAT.map(row => JSON.stringify(row))]
        );
    });

    afterEach(async () => {
        await client.query('DELETE FROM atomicassets_templates WHERE contract = $1', [CONTRACT]);
        await client.query('DELETE FROM atomicassets_schemas WHERE contract = $1', [CONTRACT]);
        await client.query('DELETE FROM atomicassets_collections WHERE contract = $1', [CONTRACT]);
        await client.query('DELETE FROM atomicassets_config WHERE contract = $1', [CONTRACT]);
    });

    async function insertTemplate(templateId: number, overrides: Record<string, any> = {}): Promise<void> {
        await client.query(
            'INSERT INTO atomicassets_templates ' +
            '(contract, template_id, collection_name, schema_name, transferable, burnable, max_supply, issued_supply, ' +
            'immutable_data, mutable_data, created_at_block, created_at_time, deleted_at_block, deleted_at_time) ' +
            'VALUES ($1, $2, $3, $4, true, true, 0, 0, $5, $6, 1, 1, $7, $8)',
            [
                CONTRACT, templateId, COLLECTION, SCHEMA,
                overrides.immutable_data ?? null,
                overrides.mutable_data ?? null,
                overrides.deleted_at_block ?? null,
                overrides.deleted_at_time ?? null,
            ]
        );
    }

    it('seeds mutable_data for a template present on-chain and absent in DB', async () => {
        await insertTemplate(1);

        const mutableHex = serializeSchemaData({ name: 'seeded', level: 3 });
        const rpc = createMockRpc({
            scopesByTable: { templates2: [COLLECTION], templates: [COLLECTION], schematypes: [] },
            rowsByScope: {
                templates2: { [COLLECTION]: [{ template_id: 1, schema_name: SCHEMA, mutable_serialized_data: mutableHex }] },
                templates: { [COLLECTION]: [{ template_id: 1 }] },
            },
        });

        const counts = await reconcileAtomicAssetsContract(client, rpc, CONTRACT);

        expect(counts.templates2Seeded).to.equal(1);

        const result = await client.query('SELECT mutable_data FROM atomicassets_templates WHERE contract = $1 AND template_id = $2', [CONTRACT, 1]);
        const data = typeof result.rows[0].mutable_data === 'string' ? JSON.parse(result.rows[0].mutable_data) : result.rows[0].mutable_data;
        expect(data.name).to.equal('seeded');
    });

    it('overwrites stale DB mutable_data with on-chain templates2 state', async () => {
        await insertTemplate(2, { mutable_data: JSON.stringify({ name: 'stale', level: 1 }) });

        const mutableHex = serializeSchemaData({ name: 'fresh', level: 9 });
        const rpc = createMockRpc({
            scopesByTable: { templates2: [COLLECTION], templates: [COLLECTION], schematypes: [] },
            rowsByScope: {
                templates2: { [COLLECTION]: [{ template_id: 2, schema_name: SCHEMA, mutable_serialized_data: mutableHex }] },
                templates: { [COLLECTION]: [{ template_id: 2 }] },
            },
        });

        await reconcileAtomicAssetsContract(client, rpc, CONTRACT);

        const result = await client.query('SELECT mutable_data FROM atomicassets_templates WHERE contract = $1 AND template_id = $2', [CONTRACT, 2]);
        const data = typeof result.rows[0].mutable_data === 'string' ? JSON.parse(result.rows[0].mutable_data) : result.rows[0].mutable_data;
        expect(data.name).to.equal('fresh');
    });

    it('NULLs mutable_data for a template whose templates2 row is gone on-chain', async () => {
        await insertTemplate(3, { mutable_data: JSON.stringify({ name: 'gone', level: 1 }) });
        await insertTemplate(30, { mutable_data: JSON.stringify({ name: 'survivor', level: 2 }) });

        const survivorHex = serializeSchemaData({ name: 'survivor', level: 2 });
        const rpc = createMockRpc({
            scopesByTable: { templates2: [COLLECTION], templates: [COLLECTION], schematypes: [] },
            rowsByScope: {
                templates2: { [COLLECTION]: [{ template_id: 30, schema_name: SCHEMA, mutable_serialized_data: survivorHex }] },
                templates: { [COLLECTION]: [{ template_id: 3 }, { template_id: 30 }] },
            },
        });

        const counts = await reconcileAtomicAssetsContract(client, rpc, CONTRACT);
        expect(counts.templatesMutableDataNulled).to.equal(1);

        const result = await client.query('SELECT mutable_data FROM atomicassets_templates WHERE contract = $1 AND template_id = $2', [CONTRACT, 3]);
        expect(result.rows[0].mutable_data).to.equal(null);

        const survivorResult = await client.query('SELECT mutable_data FROM atomicassets_templates WHERE contract = $1 AND template_id = $2', [CONTRACT, 30]);
        expect(survivorResult.rows[0].mutable_data).to.not.equal(null);
    });

    it('marks a DB-live template absent from on-chain templates as deleted at the snapshot head block', async () => {
        await insertTemplate(4);
        await insertTemplate(40);

        const rpc = createMockRpc({
            scopesByTable: { templates2: [], templates: [COLLECTION], schematypes: [] },
            rowsByScope: { templates: { [COLLECTION]: [{ template_id: 40 }] } },
        });

        const counts = await reconcileAtomicAssetsContract(client, rpc, CONTRACT);
        expect(counts.templatesMarkedDeleted).to.equal(1);

        const result = await client.query('SELECT deleted_at_block, deleted_at_time FROM atomicassets_templates WHERE contract = $1 AND template_id = $2', [CONTRACT, 4]);
        expect(Number(result.rows[0].deleted_at_block)).to.equal(HEAD_BLOCK);
        expect(result.rows[0].deleted_at_time).to.not.equal(null);

        const survivorResult = await client.query('SELECT deleted_at_block FROM atomicassets_templates WHERE contract = $1 AND template_id = $2', [CONTRACT, 40]);
        expect(survivorResult.rows[0].deleted_at_block).to.equal(null);
    });

    it('does not touch templates already marked deleted', async () => {
        await insertTemplate(5, { deleted_at_block: 500, deleted_at_time: 500_000 });

        const rpc = createMockRpc({
            scopesByTable: { templates2: [], templates: [], schematypes: [] },
        });

        const counts = await reconcileAtomicAssetsContract(client, rpc, CONTRACT);
        expect(counts.templatesMarkedDeleted).to.equal(0);

        const result = await client.query('SELECT deleted_at_block FROM atomicassets_templates WHERE contract = $1 AND template_id = $2', [CONTRACT, 5]);
        expect(Number(result.rows[0].deleted_at_block)).to.equal(500);
    });

    it('seeds schema types and collection new_author_name/new_author_date from chain', async () => {
        const rpc = createMockRpc({
            scopesByTable: { templates2: [], templates: [], schematypes: [COLLECTION] },
            rowsByScope: {
                schematypes: { [COLLECTION]: [{ schema_name: SCHEMA, format_type: [{ name: 'name', mediatype: 'text/plain', info: '' }] }] },
            },
        });

        // authorswaps is scoped by the contract account, not per-collection
        const authorswapsRpc: ReconcileRpc = {
            ...rpc,
            get_table_rows: async (params: any) => {
                if (params.table === 'authorswaps') {
                    return { rows: [{ collection_name: COLLECTION, current_author: 'creator11111', new_author: 'newauth11111', acceptance_date: 1_800_000_000 }], more: false };
                }
                return rpc.get_table_rows(params);
            },
        };

        const counts = await reconcileAtomicAssetsContract(client, authorswapsRpc, CONTRACT);
        expect(counts.schemaTypesSeeded).to.equal(1);
        expect(counts.authorSwapsSeeded).to.equal(1);

        const schemaResult = await client.query('SELECT types FROM atomicassets_schemas WHERE contract = $1 AND collection_name = $2 AND schema_name = $3', [CONTRACT, COLLECTION, SCHEMA]);
        expect(schemaResult.rows[0].types.length).to.equal(1);

        const collectionResult = await client.query('SELECT new_author_name, new_author_date FROM atomicassets_collections WHERE contract = $1 AND collection_name = $2', [CONTRACT, COLLECTION]);
        expect(collectionResult.rows[0].new_author_name).to.equal('newauth11111');
        expect(Number(collectionResult.rows[0].new_author_date)).to.equal(1_800_000_000 * 1000);
    });

    it('is a no-op on a second run over unchanged chain state', async () => {
        await insertTemplate(6);

        const mutableHex = serializeSchemaData({ name: 'stable', level: 5 });
        const rpc = createMockRpc({
            scopesByTable: { templates2: [COLLECTION], templates: [COLLECTION], schematypes: [] },
            rowsByScope: {
                templates2: { [COLLECTION]: [{ template_id: 6, schema_name: SCHEMA, mutable_serialized_data: mutableHex }] },
                templates: { [COLLECTION]: [{ template_id: 6 }] },
            },
        });

        await reconcileAtomicAssetsContract(client, rpc, CONTRACT);
        const first = await client.query('SELECT mutable_data, deleted_at_block FROM atomicassets_templates WHERE contract = $1 AND template_id = $2', [CONTRACT, 6]);

        await reconcileAtomicAssetsContract(client, rpc, CONTRACT);
        const second = await client.query('SELECT mutable_data, deleted_at_block FROM atomicassets_templates WHERE contract = $1 AND template_id = $2', [CONTRACT, 6]);

        expect(second.rows[0].mutable_data).to.deep.equal(first.rows[0].mutable_data);
        expect(second.rows[0].deleted_at_block).to.equal(first.rows[0].deleted_at_block);
    });

    it('throws instead of mass-deleting when on-chain templates enumeration is empty but DB has live templates', async () => {
        await insertTemplate(7);

        const rpc = createMockRpc({
            scopesByTable: { templates2: [], templates: [], schematypes: [] },
        });

        let thrown: unknown;
        try {
            await reconcileAtomicAssetsContract(client, rpc, CONTRACT);
        } catch (error) {
            thrown = error;
        }

        expect(thrown).to.be.instanceOf(Error);
        expect((thrown as Error).message).to.match(/templates enumeration.*returned zero rows/);

        const result = await client.query('SELECT deleted_at_block FROM atomicassets_templates WHERE contract = $1 AND template_id = $2', [CONTRACT, 7]);
        expect(result.rows[0].deleted_at_block).to.equal(null);
    });

    it('throws instead of wiping mutable_data when on-chain templates2 enumeration is empty but DB has live mutable_data', async () => {
        await insertTemplate(8, { mutable_data: JSON.stringify({ name: 'keepme', level: 1 }) });

        const rpc = createMockRpc({
            // templates walk is non-empty so the deletion-diff guard does not fire first;
            // only templates2 is empty here.
            scopesByTable: { templates2: [], templates: [COLLECTION], schematypes: [] },
            rowsByScope: { templates: { [COLLECTION]: [{ template_id: 8 }] } },
        });

        let thrown: unknown;
        try {
            await reconcileAtomicAssetsContract(client, rpc, CONTRACT);
        } catch (error) {
            thrown = error;
        }

        expect(thrown).to.be.instanceOf(Error);
        expect((thrown as Error).message).to.match(/templates2 enumeration.*returned zero rows/);

        const result = await client.query('SELECT mutable_data FROM atomicassets_templates WHERE contract = $1 AND template_id = $2', [CONTRACT, 8]);
        const data = typeof result.rows[0].mutable_data === 'string' ? JSON.parse(result.rows[0].mutable_data) : result.rows[0].mutable_data;
        expect(data.name).to.equal('keepme');
    });

    it('throws instead of clearing pending author swaps when on-chain authorswaps enumeration is empty but DB has a pending swap', async () => {
        await client.query(
            'UPDATE atomicassets_collections SET new_author_name = $1, new_author_date = $2 WHERE contract = $3 AND collection_name = $4',
            ['pendingauth1', 1_700_000_000_000, CONTRACT, COLLECTION]
        );

        const rpc = createMockRpc({
            scopesByTable: { templates2: [], templates: [], schematypes: [] },
        });

        let thrown: unknown;
        try {
            await reconcileAtomicAssetsContract(client, rpc, CONTRACT);
        } catch (error) {
            thrown = error;
        }

        expect(thrown).to.be.instanceOf(Error);
        expect((thrown as Error).message).to.match(/authorswaps enumeration.*returned zero rows/);

        const result = await client.query('SELECT new_author_name FROM atomicassets_collections WHERE contract = $1 AND collection_name = $2', [CONTRACT, COLLECTION]);
        expect(result.rows[0].new_author_name).to.equal('pendingauth1');
    });

    it('is a legitimate no-op (no throw) when on-chain enumeration and DB live rows are both empty', async () => {
        const rpc = createMockRpc({
            scopesByTable: { templates2: [], templates: [], schematypes: [] },
        });

        const counts = await reconcileAtomicAssetsContract(client, rpc, CONTRACT);

        expect(counts.templatesMarkedDeleted).to.equal(0);
        expect(counts.templatesMutableDataNulled).to.equal(0);
        expect(counts.authorSwapsCleared).to.equal(0);
    });

    it('preserves mutable_data for a templates2 row whose schema is locally unknown instead of nulling it out', async () => {
        await insertTemplate(9, { mutable_data: JSON.stringify({ name: 'unknown-schema-data', level: 1 }) });

        const mutableHex = serializeSchemaData({ name: 'irrelevant', level: 1 });
        const rpc = createMockRpc({
            scopesByTable: { templates2: [COLLECTION], templates: [COLLECTION], schematypes: [] },
            rowsByScope: {
                templates2: { [COLLECTION]: [{ template_id: 9, schema_name: 'unknownschema', mutable_serialized_data: mutableHex }] },
                templates: { [COLLECTION]: [{ template_id: 9 }] },
            },
        });

        const counts = await reconcileAtomicAssetsContract(client, rpc, CONTRACT);

        expect(counts.templates2Seeded).to.equal(0);
        expect(counts.templatesMutableDataNulled).to.equal(0);

        const result = await client.query('SELECT mutable_data FROM atomicassets_templates WHERE contract = $1 AND template_id = $2', [CONTRACT, 9]);
        const data = typeof result.rows[0].mutable_data === 'string' ? JSON.parse(result.rows[0].mutable_data) : result.rows[0].mutable_data;
        expect(data.name).to.equal('unknown-schema-data');
    });

    it('sets v2_marker_block to the snapshot head block on success', async () => {
        const rpc = createMockRpc({
            scopesByTable: { templates2: [], templates: [], schematypes: [] },
        });

        await reconcileAtomicAssetsContract(client, rpc, CONTRACT);

        const result = await client.query('SELECT v2_marker_block FROM atomicassets_config WHERE contract = $1', [CONTRACT]);
        expect(Number(result.rows[0].v2_marker_block)).to.equal(HEAD_BLOCK);
    });
});
