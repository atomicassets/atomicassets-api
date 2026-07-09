import 'mocha';
import { expect } from 'chai';
import { Client } from 'pg';
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
import { TemplatesTableRow } from '../types/tables';
import { ModuleLoader } from '../../../modules';

const CONTRACT = 'atomicassets';
const COLLECTION = 'tmplcol11111';
const SCHEMA = 'tmplschema11';

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

    async function seedTemplate(templateId: string): Promise<void> {
        await client.query(
            `INSERT INTO atomicassets_templates
                (contract, template_id, collection_name, schema_name, transferable, burnable,
                 max_supply, issued_supply, immutable_data,
                 created_at_block, created_at_time)
             VALUES ($1, $2, $3, $4, true, true, 10, 0, '{}', 1, 1)`,
            [CONTRACT, templateId, COLLECTION, SCHEMA]
        );
    }

    describe('templates delta with present=false (AtomicAssets v2 deltemplate)', () => {
        it('keeps the indexed row intact and does not throw for an existing template', async () => {
            const templateId = '2001';
            await seedTemplate(templateId);

            const block = createBlock({ timestamp: '2023-08-20T08:30:00.000' });
            const deltaValue: TemplatesTableRow = {
                template_id: templateId,
                schema_name: SCHEMA,
                transferable: true,
                burnable: true,
                max_supply: '10',
                issued_supply: '0',
                immutable_serialized_data: [] as any,
            };
            const delta = createContractRow(CONTRACT, 'templates', deltaValue, false, {
                scope: COLLECTION,
            });

            await processContractRow(processor, db, block, delta);

            const result = await client.query(
                'SELECT collection_name, schema_name, max_supply, issued_supply FROM atomicassets_templates WHERE contract = $1 AND template_id = $2',
                [CONTRACT, templateId]
            );
            expect(result.rowCount).to.equal(1);
            expect(result.rows[0].collection_name).to.equal(COLLECTION);
            expect(result.rows[0].schema_name).to.equal(SCHEMA);
            expect(Number(result.rows[0].max_supply)).to.equal(10);
            expect(Number(result.rows[0].issued_supply)).to.equal(0);
        });

        it('is a no-op for a never-indexed template (no placeholder row inserted)', async () => {
            const templateId = '2002';

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

            const result = await client.query(
                'SELECT * FROM atomicassets_templates WHERE contract = $1 AND template_id = $2',
                [CONTRACT, templateId]
            );
            expect(result.rowCount).to.equal(0);
        });
    });
});
