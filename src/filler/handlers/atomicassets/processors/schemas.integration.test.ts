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
import { schemaProcessor } from './schemas';
import DataProcessor, { ProcessingState } from '../../../processor';
import { ContractDBTransaction } from '../../../database';
import { SchemaTypesTableRow, SchemasTableRow } from '../types/tables';
import { ModuleLoader } from '../../../modules';

const CONTRACT = 'atomicassets';
const COLLECTION = 'schemacol111';
const SCHEMA = 'schematest11';

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

describe('schemaProcessor', () => {
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
        destroyProcessor = schemaProcessor(core as any, processor);

        // The schemas row has a FK on (collection_name, contract) -> atomicassets_collections.
        await client.query(
            `INSERT INTO atomicassets_collections
                (contract, collection_name, author, allow_notify, authorized_accounts,
                 notify_accounts, market_fee, data, created_at_block, created_at_time)
             VALUES ($1, $2, $3, true, $4, $5, 0, $6, 1, 1)`,
            [CONTRACT, COLLECTION, 'author111111', ['author111111'], [], '{}']
        );
    });

    afterEach(async () => {
        if (destroyProcessor) {
            destroyProcessor();
        }
        await client.query('ROLLBACK');
    });

    describe('schemas table delta (create)', () => {
        it('round-trips the format entries as jsonb objects', async () => {
            const block = createBlock({ timestamp: '2023-03-15T10:00:00.000' });

            const deltaValue: SchemasTableRow = {
                schema_name: SCHEMA,
                format: [
                    { name: 'name', type: 'string' },
                    { name: 'img', type: 'image' },
                ],
            };

            const delta = createContractRow(CONTRACT, 'schemas', deltaValue, true, { scope: COLLECTION });

            await processContractRow(processor, db, block, delta);

            const result = await client.query(
                'SELECT * FROM atomicassets_schemas WHERE contract = $1 AND collection_name = $2 AND schema_name = $3',
                [CONTRACT, COLLECTION, SCHEMA]
            );
            expect(result.rowCount).to.equal(1);

            // format is jsonb[], so the driver hands back parsed objects rather
            // than the strings the processor passed in.
            expect(result.rows[0].format).to.deep.equal([
                { name: 'name', type: 'string' },
                { name: 'img', type: 'image' },
            ]);
        });

        it('should throw when delta.present is false', async () => {
            const block = createBlock();

            const deltaValue: SchemasTableRow = {
                schema_name: SCHEMA,
                format: [],
            };

            const delta = createContractRow(CONTRACT, 'schemas', deltaValue, false, { scope: COLLECTION });

            try {
                await processContractRow(processor, db, block, delta);
                expect.fail('Should have thrown an error');
            } catch (err: any) {
                expect(err.message).to.include('A schema was deleted');
            }
        });
    });

    describe('schematypes table delta', () => {
        it('round-trips the format_type entries as jsonb `types` objects', async () => {
            const createBlockDelta = createContractRow<SchemasTableRow>(CONTRACT, 'schemas', {
                schema_name: SCHEMA,
                format: [{ name: 'name', type: 'string' }],
            }, true, { scope: COLLECTION });
            await processContractRow(processor, db, createBlock({ timestamp: '2023-03-15T10:00:00.000' }), createBlockDelta);

            const block = createBlock({ timestamp: '2023-03-16T10:00:00.000' });

            const deltaValue: SchemaTypesTableRow = {
                schema_name: SCHEMA,
                format_type: [
                    { name: 'name', mediatype: 'name', info: 'display name' },
                ],
            };

            const delta = createContractRow(CONTRACT, 'schematypes', deltaValue, true, { scope: COLLECTION });

            await processContractRow(processor, db, block, delta);

            const result = await client.query(
                'SELECT types FROM atomicassets_schemas WHERE contract = $1 AND collection_name = $2 AND schema_name = $3',
                [CONTRACT, COLLECTION, SCHEMA]
            );
            expect(result.rowCount).to.equal(1);

            expect(result.rows[0].types).to.deep.equal([
                { name: 'name', mediatype: 'name', info: 'display name' },
            ]);
        });

        it('should throw when delta.present is false', async () => {
            const block = createBlock();

            const deltaValue: SchemaTypesTableRow = {
                schema_name: SCHEMA,
                format_type: [],
            };

            const delta = createContractRow(CONTRACT, 'schematypes', deltaValue, false, { scope: COLLECTION });

            try {
                await processContractRow(processor, db, block, delta);
                expect.fail('Should have thrown an error');
            } catch (err: any) {
                expect(err.message).to.include('A schema type was deleted');
            }
        });
    });
});
