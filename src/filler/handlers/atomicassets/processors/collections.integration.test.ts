import 'mocha';
import { expect } from 'chai';
import { Client } from 'pg';
import { serialize, ObjectSchema } from '@atomichub/atomicassets';
import type { CollectionsTableRow } from '@atomichub/atomicassets';
import {
    createProcessorTestContext,
    createBlock,
    createContractRow,
    processContractRow,
    createTestTransaction,
} from '../../test-helper';
import { collectionProcessor } from './collections';
import DataProcessor, { ProcessingState } from '../../../processor';
import { ContractDBTransaction } from '../../../database';
import { ModuleLoader } from '../../../modules';

const CONTRACT = 'atomicassets';

// The standard AtomicAssets collection format
const COLLECTION_FORMAT = [
    { name: 'name', type: 'string' },
    { name: 'img', type: 'string' },
    { name: 'description', type: 'string' },
    { name: 'url', type: 'string' },
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
            collection_format: COLLECTION_FORMAT,
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
 * Serialize collection data into the byte format expected by the AtomicAssets contract.
 */
function serializeCollectionData(data: Record<string, string>): string {
    const schema = ObjectSchema(COLLECTION_FORMAT);
    const serialized = serialize(data, schema);
    return Buffer.from(serialized).toString('hex');
}

describe('collectionProcessor', () => {
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
        destroyProcessor = collectionProcessor(core as any, processor);
    });

    afterEach(async () => {
        if (destroyProcessor) {
            destroyProcessor();
        }
        await client.query('ROLLBACK');
    });

    describe('collections table delta (create)', () => {
        it('should insert a new collection from a contract row delta', async () => {
            const block = createBlock({ timestamp: '2023-03-15T10:00:00.000' });

            const serializedData = serializeCollectionData({
                name: 'My Cool Collection',
                img: 'QmTest123',
                description: 'A test collection',
                url: 'https://test.com',
            });

            const deltaValue: CollectionsTableRow = {
                collection_name: 'coolcol11111',
                author: 'creator11111',
                allow_notify: 1,
                authorized_accounts: ['creator11111', 'helper111111'],
                notify_accounts: ['notifier1111'],
                market_fee: 0.05,
                serialized_data: serializedData as any,
            };

            const delta = createContractRow(CONTRACT, 'collections', deltaValue, true);

            await processContractRow(processor, db, block, delta);

            const result = await client.query(
                'SELECT * FROM atomicassets_collections WHERE contract = $1 AND collection_name = $2',
                [CONTRACT, 'coolcol11111']
            );
            expect(result.rowCount).to.equal(1);
            const col = result.rows[0];
            expect(col.author).to.equal('creator11111');
            expect(col.allow_notify).to.equal(true);
            expect(col.authorized_accounts).to.deep.equal(['creator11111', 'helper111111']);
            expect(col.notify_accounts).to.deep.equal(['notifier1111']);
            expect(parseFloat(col.market_fee)).to.equal(0.05);

            const data = (typeof col.data === 'string' ? JSON.parse(col.data) : col.data);
            expect(data.name).to.equal('My Cool Collection');
            expect(data.img).to.equal('QmTest123');
        });

        it('should update an existing collection via replace (upsert)', async () => {
            const block1 = createBlock({ timestamp: '2023-03-15T10:00:00.000' });

            const serializedData1 = serializeCollectionData({
                name: 'Original Name',
                img: 'QmOriginal',
                description: 'Original description',
                url: 'https://original.com',
            });

            const deltaValue1: CollectionsTableRow = {
                collection_name: 'upsertcol111',
                author: 'creator11111',
                allow_notify: 1,
                authorized_accounts: ['creator11111'],
                notify_accounts: [],
                market_fee: 0.02,
                serialized_data: serializedData1 as any,
            };

            const delta1 = createContractRow(CONTRACT, 'collections', deltaValue1, true);
            await processContractRow(processor, db, block1, delta1);

            // Now update it
            const block2 = createBlock({ timestamp: '2023-04-01T12:00:00.000' });

            const serializedData2 = serializeCollectionData({
                name: 'Updated Name',
                img: 'QmUpdated',
                description: 'Updated description',
                url: 'https://updated.com',
            });

            const deltaValue2: CollectionsTableRow = {
                collection_name: 'upsertcol111',
                author: 'creator11111',
                allow_notify: 1,
                authorized_accounts: ['creator11111', 'newauth11111'],
                notify_accounts: [],
                market_fee: 0.03,
                serialized_data: serializedData2 as any,
            };

            const delta2 = createContractRow(CONTRACT, 'collections', deltaValue2, true);
            await processContractRow(processor, db, block2, delta2);

            const result = await client.query(
                'SELECT * FROM atomicassets_collections WHERE contract = $1 AND collection_name = $2',
                [CONTRACT, 'upsertcol111']
            );
            expect(result.rowCount).to.equal(1);
            const col = result.rows[0];
            expect(col.authorized_accounts).to.deep.equal(['creator11111', 'newauth11111']);
            expect(parseFloat(col.market_fee)).to.equal(0.03);

            const data = (typeof col.data === 'string' ? JSON.parse(col.data) : col.data);
            expect(data.name).to.equal('Updated Name');
            expect(data.img).to.equal('QmUpdated');
        });

        it('should throw when delta.present is false', async () => {
            const block = createBlock();

            const deltaValue: CollectionsTableRow = {
                collection_name: 'deleted11111',
                author: 'creator11111',
                allow_notify: 0,
                authorized_accounts: [],
                notify_accounts: [],
                market_fee: 0,
                serialized_data: [] as any,
            };

            const delta = createContractRow(CONTRACT, 'collections', deltaValue, false);

            try {
                await processContractRow(processor, db, block, delta);
                expect.fail('Should have thrown an error');
            } catch (err: any) {
                expect(err.message).to.include('A collection was deleted');
            }
        });
    });
});
