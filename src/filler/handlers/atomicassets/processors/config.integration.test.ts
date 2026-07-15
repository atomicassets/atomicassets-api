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
import { configProcessor } from './config';
import DataProcessor, { ProcessingState } from '../../../processor';
import { ContractDBTransaction } from '../../../database';
import { TokenConfigsTableRow } from '../types/tables';
import { ModuleLoader } from '../../../modules';

const CONTRACT = 'atomicassets';

function createMockCore(overrides: Record<string, any> = {}): any {
    return {
        args: {
            atomicassets_account: CONTRACT,
            store_transfers: true,
            store_logs: false,
        },
        config: {
            collection_format: [],
            supported_tokens: [],
            asset_counter: 0,
            offer_counter: 0,
        },
        tokenconfigs: {
            standard: 'atomicassets',
            version: '1.3.25',
        },
        ...overrides,
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

async function seedConfigRow(client: Client, markerBlock: number | null = null): Promise<void> {
    await client.query(
        'INSERT INTO atomicassets_config (contract, version, collection_format, v2_marker_block) ' +
        'VALUES ($1, $2, ARRAY[]::jsonb[], $3)',
        [CONTRACT, '1.3.25', markerBlock]
    );
}

describe('configProcessor v2 marker', () => {
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
    });

    afterEach(async () => {
        if (destroyProcessor) {
            destroyProcessor();
        }
        await client.query('ROLLBACK');
    });

    it('writes v2_marker_block at the delta block when a v2 tokenconfigs delta is processed and the marker is NULL', async () => {
        await seedConfigRow(client, null);

        const core = createMockCore();
        destroyProcessor = configProcessor(core, processor);

        const block = createBlock();
        const deltaValue: TokenConfigsTableRow = { standard: 'atomicassets', version: '2.0.0' };
        const delta = createContractRow(CONTRACT, 'tokenconfigs', deltaValue, true);

        await processContractRow(processor, db, block, delta);

        const result = await client.query(
            'SELECT v2_marker_block FROM atomicassets_config WHERE contract = $1',
            [CONTRACT]
        );

        expect(Number(result.rows[0].v2_marker_block)).to.equal(block.block_num);
    });

    it('writes no marker for a v1.x tokenconfigs delta', async () => {
        await seedConfigRow(client, null);

        const core = createMockCore();
        destroyProcessor = configProcessor(core, processor);

        const block = createBlock();
        const deltaValue: TokenConfigsTableRow = { standard: 'atomicassets', version: '1.3.26' };
        const delta = createContractRow(CONTRACT, 'tokenconfigs', deltaValue, true);

        await processContractRow(processor, db, block, delta);

        const result = await client.query(
            'SELECT v2_marker_block FROM atomicassets_config WHERE contract = $1',
            [CONTRACT]
        );

        expect(result.rows[0].v2_marker_block).to.equal(null);
    });

    it('leaves an already-set marker unchanged when a v2 delta is replayed (rewound-replay idempotence)', async () => {
        const existingMarkerBlock = 111;
        await seedConfigRow(client, existingMarkerBlock);

        const core = createMockCore();
        destroyProcessor = configProcessor(core, processor);

        const block = createBlock();
        const deltaValue: TokenConfigsTableRow = { standard: 'atomicassets', version: '2.0.0' };
        const delta = createContractRow(CONTRACT, 'tokenconfigs', deltaValue, true);

        await processContractRow(processor, db, block, delta);

        const result = await client.query(
            'SELECT v2_marker_block FROM atomicassets_config WHERE contract = $1',
            [CONTRACT]
        );

        expect(Number(result.rows[0].v2_marker_block)).to.equal(existingMarkerBlock);
        expect(Number(result.rows[0].v2_marker_block)).to.not.equal(block.block_num);
    });
});
