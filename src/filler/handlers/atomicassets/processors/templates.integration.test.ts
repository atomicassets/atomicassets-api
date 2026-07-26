import 'mocha';
import { expect } from 'chai';
import { Client } from 'pg';
import { serialize, ObjectSchema } from '@atomichub/atomicassets';
import type { MutableTemplatesTableRow, TemplatesTableRow } from '@atomichub/atomicassets';
import {
    createProcessorTestContext,
    createBlock,
    createContractRow,
    processContractRow,
    createTestTransaction,
} from '../../test-helper';
import { templateProcessor } from './templates';
import DataProcessor, { ProcessingState } from '../../../processor';
import { ContractDBTransaction } from '../../../database';
import { ModuleLoader } from '../../../modules';
import { eosioTimestampToDate } from '../../../../utils/eosio';

const CONTRACT = 'atomicassets';
const COLLECTION = 'tmplcol11111';
const SCHEMA = 'tmplschema11';

// A simple schema format used to (de)serialize mutable_data payloads.
const SCHEMA_FORMAT = [
    { name: 'name', type: 'string' },
    { name: 'level', type: 'uint64' },
];

function createMockCore(overrides: Record<string, any> = {}): any {
    return {
        args: {
            atomicassets_account: CONTRACT,
            store_transfers: true,
            store_logs: false,
            ...overrides,
        },
        config: {
            collection_format: [],
            supported_tokens: [],
            asset_counter: 0,
            offer_counter: 0,
        },
    };
}

function createMockModuleLoader(): ModuleLoader {
    const loader = Object.create(ModuleLoader.prototype) as ModuleLoader;
    // @ts-ignore
    loader.modules = [];
    // @ts-ignore
    loader.names = [];
    return loader;
}

/**
 * Serialize template mutable/immutable data into the contract byte format (hex string).
 */
function serializeSchemaData(data: Record<string, any>): string {
    const schema = ObjectSchema(SCHEMA_FORMAT);
    const serialized = serialize(data, schema);
    return Buffer.from(serialized).toString('hex');
}

describe('templateProcessor', () => {
    let client: Client;
    let processor: DataProcessor;
    let db: ContractDBTransaction;
    let destroyProcessor: () => any;

    before(async () => {
        const ctx = createProcessorTestContext();
        client = ctx.client;
        await client.connect();
    });

    after(async () => {
        await client.end();
    });

    beforeEach(async () => {
        await client.query('BEGIN');
        processor = new DataProcessor(ProcessingState.HEAD, createMockModuleLoader());
        db = createTestTransaction(client);
        const core = createMockCore();
        destroyProcessor = templateProcessor(core as any, processor);

        // Seed parent rows (collection + schema) so the present=true templates2 path
        // can look up the schema format. FKs are DEFERRABLE INITIALLY DEFERRED so the
        // ordering inside the txn is fine; we seed them anyway to mirror real state.
        await client.query(
            `INSERT INTO atomicassets_collections
                (contract, collection_name, author, allow_notify, authorized_accounts,
                 notify_accounts, market_fee, data, created_at_block, created_at_time)
             VALUES ($1, $2, $3, true, $4, $5, 0, $6, 1, 1)`,
            [CONTRACT, COLLECTION, 'author111111', ['author111111'], [], '{}']
        );
        await client.query(
            `INSERT INTO atomicassets_schemas
                (contract, collection_name, schema_name, format, created_at_block, created_at_time)
             VALUES ($1, $2, $3, $4::jsonb[], 1, 1)`,
            [CONTRACT, COLLECTION, SCHEMA, SCHEMA_FORMAT.map(r => JSON.stringify(r))]
        );
    });

    afterEach(async () => {
        if (destroyProcessor) {
            destroyProcessor();
        }
        await client.query('ROLLBACK');
    });

    /**
     * Seed an existing base template row (mutable_data NULL) so the templates2
     * handler has a row to UPDATE by template_id.
     */
    async function seedTemplate(templateId: string, mutableData: string | null = null): Promise<void> {
        await client.query(
            `INSERT INTO atomicassets_templates
                (contract, template_id, collection_name, schema_name, transferable, burnable,
                 max_supply, issued_supply, immutable_data, mutable_data,
                 created_at_block, created_at_time)
             VALUES ($1, $2, $3, $4, true, true, 0, 0, '{}', $5, 1, 1)`,
            [CONTRACT, templateId, COLLECTION, SCHEMA, mutableData]
        );
    }

    describe('templates2 mutable_data delta', () => {
        it('sets mutable_data to the deserialized non-null payload (B-API-TABLE-NAME)', async () => {
            const templateId = '1001';
            await seedTemplate(templateId);

            const block = createBlock({ timestamp: '2023-05-01T10:00:00.000' });
            const serialized = serializeSchemaData({ name: 'Mutable Template', level: 7 });

            const deltaValue: MutableTemplatesTableRow = {
                template_id: templateId,
                schema_name: SCHEMA,
                mutable_serialized_data: serialized as any,
            };
            const delta = createContractRow(CONTRACT, 'templates2', deltaValue, true, {
                scope: COLLECTION,
            });

            await processContractRow(processor, db, block, delta);

            const result = await client.query(
                'SELECT mutable_data FROM atomicassets_templates WHERE contract = $1 AND template_id = $2',
                [CONTRACT, templateId]
            );
            expect(result.rowCount).to.equal(1);
            const md = result.rows[0].mutable_data;
            const parsed = typeof md === 'string' ? JSON.parse(md) : md;
            expect(parsed).to.not.be.null;
            expect(parsed).to.deep.equal({ name: 'Mutable Template', level: '7' });
        });

        it('clears mutable_data back to NULL when present=false (A-MUT-ROW-DELETE)', async () => {
            const templateId = '1002';
            // Seed with pre-existing non-null mutable_data.
            await seedTemplate(templateId, JSON.stringify({ name: 'Stale', level: '3' }));

            // Sanity: it starts non-null.
            const before = await client.query(
                'SELECT mutable_data FROM atomicassets_templates WHERE contract = $1 AND template_id = $2',
                [CONTRACT, templateId]
            );
            expect(before.rows[0].mutable_data).to.not.be.null;

            const block = createBlock();
            const deltaValue: MutableTemplatesTableRow = {
                template_id: templateId,
                schema_name: SCHEMA,
                mutable_serialized_data: [] as any,
            };
            const delta = createContractRow(CONTRACT, 'templates2', deltaValue, false, {
                scope: COLLECTION,
            });

            await processContractRow(processor, db, block, delta);

            const after = await client.query(
                'SELECT mutable_data FROM atomicassets_templates WHERE contract = $1 AND template_id = $2',
                [CONTRACT, templateId]
            );
            expect(after.rowCount).to.equal(1);
            expect(after.rows[0].mutable_data).to.be.null;
        });

        it('does NOT populate mutable_data when fed the wrong/old table name tmplmutables (anti-regression)', async () => {
            const templateId = '1003';
            await seedTemplate(templateId);

            const block = createBlock();
            const serialized = serializeSchemaData({ name: 'Should Not Land', level: 9 });

            const deltaValue: MutableTemplatesTableRow = {
                template_id: templateId,
                schema_name: SCHEMA,
                mutable_serialized_data: serialized as any,
            };
            // Feed the legacy/wrong table name. The processor subscribes to 'templates2',
            // so this delta must be ignored entirely.
            const delta = createContractRow(CONTRACT, 'tmplmutables', deltaValue, true, {
                scope: COLLECTION,
            });

            await processContractRow(processor, db, block, delta);

            const result = await client.query(
                'SELECT mutable_data FROM atomicassets_templates WHERE contract = $1 AND template_id = $2',
                [CONTRACT, templateId]
            );
            expect(result.rowCount).to.equal(1);
            expect(result.rows[0].mutable_data).to.be.null;
        });

        it('is a sane no-op for an orphan template_id with no existing templates row', async () => {
            const templateId = '9999999';
            // Intentionally do NOT seed a template row.

            const block = createBlock();
            const serialized = serializeSchemaData({ name: 'Orphan', level: 1 });

            const deltaValue: MutableTemplatesTableRow = {
                template_id: templateId,
                schema_name: SCHEMA,
                mutable_serialized_data: serialized as any,
            };
            const delta = createContractRow(CONTRACT, 'templates2', deltaValue, true, {
                scope: COLLECTION,
            });

            // Must not throw.
            await processContractRow(processor, db, block, delta);

            // And must not have created a row.
            const result = await client.query(
                'SELECT * FROM atomicassets_templates WHERE contract = $1 AND template_id = $2',
                [CONTRACT, templateId]
            );
            expect(result.rowCount).to.equal(0);
        });
    });

    describe('templates immutable delta (deltemplate / deleted_at)', () => {
        it('sets deleted_at_block/deleted_at_time when present=false for an existing template', async () => {
            const templateId = '2001';
            await seedTemplate(templateId);

            const block = createBlock({ timestamp: '2023-08-20T08:30:00.000' });
            const deltaValue: TemplatesTableRow = {
                template_id: templateId,
                schema_name: SCHEMA,
                transferable: true,
                burnable: true,
                max_supply: '0',
                issued_supply: '5',
                immutable_serialized_data: [] as any,
            };
            const delta = createContractRow(CONTRACT, 'templates', deltaValue, false, {
                scope: COLLECTION,
            });

            await processContractRow(processor, db, block, delta);

            const result = await client.query(
                'SELECT deleted_at_block, deleted_at_time FROM atomicassets_templates WHERE contract = $1 AND template_id = $2',
                [CONTRACT, templateId]
            );
            expect(result.rowCount).to.equal(1);
            expect(Number(result.rows[0].deleted_at_block)).to.equal(block.block_num);
            expect(Number(result.rows[0].deleted_at_time)).to.equal(
                eosioTimestampToDate(block.timestamp).getTime()
            );
        });

        it('SKIPS rather than inserting a deleted placeholder for a never-indexed template (B-TMPL-DELETE-INSERT-EDGE)', async () => {
            const templateId = '2002';
            // Intentionally do NOT seed a template row (rowCount === 0 branch).

            const block = createBlock();
            const deltaValue: TemplatesTableRow = {
                template_id: templateId,
                schema_name: SCHEMA,
                transferable: true,
                burnable: true,
                max_supply: '0',
                issued_supply: '0',
                immutable_serialized_data: [] as any,
            };
            const delta = createContractRow(CONTRACT, 'templates', deltaValue, false, {
                scope: COLLECTION,
            });

            await processContractRow(processor, db, block, delta);

            // No placeholder deleted row should have been inserted.
            const result = await client.query(
                'SELECT * FROM atomicassets_templates WHERE contract = $1 AND template_id = $2',
                [CONTRACT, templateId]
            );
            expect(result.rowCount).to.equal(0);
        });
    });
});
