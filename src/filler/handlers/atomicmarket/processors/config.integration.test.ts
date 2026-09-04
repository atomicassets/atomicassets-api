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
import { ConfigTableRow } from '../types/tables';
import { marketDissolvesBundles } from '../legacy-bundles';
import { ModuleLoader } from '../../../modules';

const MARKET_CONTRACT = 'atomicmarket';
const READER_NAME = 'test-reader';
const ASSETS_CONTRACT = 'atomicassets';

function createMockModuleLoader(): ModuleLoader {
    const loader = Object.create(ModuleLoader.prototype) as ModuleLoader;
    // @ts-ignore
    loader.modules = [];
    // @ts-ignore
    loader.names = [];
    return loader;
}

function createConfigValue(version: string): ConfigTableRow {
    return {
        sale_counter: '0',
        auction_counter: '0',
        minimum_bid_increase: 0.1,
        minimum_auction_duration: 3600,
        maximum_auction_duration: 2592000,
        auction_reset_duration: 120,
        supported_tokens: [],
        supported_symbol_pairs: [],
        maker_market_fee: 0.01,
        taker_market_fee: 0.01,
        version,
        atomicassets_account: ASSETS_CONTRACT,
        delphioracle_account: 'delphioracle',
    };
}

function createMockCore(version: string, markerBlock: number | null): any {
    return {
        args: {
            atomicmarket_account: MARKET_CONTRACT,
            atomicassets_account: ASSETS_CONTRACT,
            delphioracle_account: 'delphioracle',
        },
        config: createConfigValue(version),
        v2MarkerBlock: markerBlock,
    };
}

describe('configProcessor v2 legacy bundle marker', () => {
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
        await client.query('DELETE FROM reversible_queries WHERE reader = $1', [READER_NAME]);
        processor = new DataProcessor(ProcessingState.HEAD, createMockModuleLoader());
        db = createTestTransaction(client);
        destroyProcessor = null;
    });

    afterEach(async () => {
        if (destroyProcessor) {
            destroyProcessor();
        }
        await client.query('ROLLBACK');
    });

    async function seedConfigRow(version: string, markerBlock: number | null): Promise<void> {
        await client.query('DELETE FROM atomicmarket_config WHERE market_contract = $1', [MARKET_CONTRACT]);
        await client.query(
            'INSERT INTO atomicmarket_config (' +
                'market_contract, assets_contract, delphi_contract, version, maker_market_fee, taker_market_fee, ' +
                'minimum_auction_duration, maximum_auction_duration, minimum_bid_increase, auction_reset_duration, v2_marker_block' +
            ') VALUES ($1, $2, $3, $4, 0.01, 0.01, 3600, 2592000, 0.1, 120, $5)',
            [MARKET_CONTRACT, ASSETS_CONTRACT, 'delphioracle', version, markerBlock]
        );
    }

    async function readMarker(): Promise<any> {
        const result = await client.query(
            'SELECT v2_marker_block FROM atomicmarket_config WHERE market_contract = $1',
            [MARKET_CONTRACT]
        );

        return result.rows[0].v2_marker_block;
    }

    async function applyDelta(core: any, version: string, block: any): Promise<void> {
        if (destroyProcessor) {
            destroyProcessor();
        }

        processor = new DataProcessor(ProcessingState.HEAD, createMockModuleLoader());
        destroyProcessor = configProcessor(core, processor);
        await processContractRow(
            processor, db, block,
            createContractRow(MARKET_CONTRACT, 'config', createConfigValue(version), true)
        );
    }

    it('writes the marker at the block of the first v2 config delta', async () => {
        // Case 1: a reader syncing a chain still on v1 reaches the flip. Everything
        // before this block keeps the v1 recording, everything from it does not.
        await seedConfigRow('1.2.2', null);
        const core = createMockCore('1.2.2', null);
        const block = createBlock();

        await applyDelta(core, '2.0.0', block);

        expect(Number(await readMarker())).to.equal(block.block_num);
        expect(core.v2MarkerBlock).to.equal(block.block_num);
    });

    it('writes no marker for a v1 config delta', async () => {
        await seedConfigRow('1.2.2', null);
        const core = createMockCore('1.2.2', null);

        await applyDelta(core, '1.2.3', createBlock());

        expect(await readMarker()).to.be.null;
        expect(core.v2MarkerBlock).to.be.null;
    });

    it('lets the canonical delta set the marker after a fork orphans the first one', async () => {
        // The marker write goes through the reversible path, so a fork that
        // orphans the flip block takes the marker with it. Left behind, it would
        // point at a block that is no longer history.
        await seedConfigRow('1.2.2', null);
        const core = createMockCore('1.2.2', null);
        const orphanedBlock = createBlock();
        const canonicalBlock = createBlock();

        try {
            // Head-mode transactions, so db.update writes the rollback log.
            db = createTestTransaction(client, READER_NAME, orphanedBlock.block_num);
            await applyDelta(core, '2.0.0', orphanedBlock);
            expect(Number(await readMarker())).to.equal(orphanedBlock.block_num);

            destroyProcessor();
            destroyProcessor = null;
            await db.rollbackReversibleBlocks(orphanedBlock.block_num);

            expect(await readMarker()).to.be.null;

            db = createTestTransaction(client, READER_NAME, canonicalBlock.block_num);
            await applyDelta(core, '2.0.0', canonicalBlock);

            expect(Number(await readMarker())).to.equal(canonicalBlock.block_num);
            expect(core.v2MarkerBlock).to.equal(canonicalBlock.block_num);
        } finally {
            // rollbackReversibleBlocks commits its chunks, so the fixtures this
            // test wrote are already durable and the afterEach rollback cannot
            // reach them. Close whatever transaction it left open, clear them for
            // real, then reopen one for that rollback to land on.
            await client.query('COMMIT');
            await client.query('DELETE FROM atomicmarket_config WHERE market_contract = $1', [MARKET_CONTRACT]);
            await client.query('DELETE FROM reversible_queries WHERE reader = $1', [READER_NAME]);
            await client.query('DELETE FROM reversible_blocks WHERE reader = $1', [READER_NAME]);
            await client.query('BEGIN');
        }
    });

    it('follows the rollback in memory when the canonical branch carries no config delta', async () => {
        // The orphaned branch carried the only v2 delta. Nothing later triggers
        // the read-back, so the fork hook is what keeps the handler's copy of the
        // row from outliving the rollback.
        await seedConfigRow('1.2.2', null);
        const core = createMockCore('1.2.2', null);
        const orphanedBlock = createBlock();

        try {
            db = createTestTransaction(client, READER_NAME, orphanedBlock.block_num);
            await applyDelta(core, '2.0.0', orphanedBlock);

            expect(Number(await readMarker())).to.equal(orphanedBlock.block_num);
            expect(core.v2MarkerBlock).to.equal(orphanedBlock.block_num);
            expect(core.config.version).to.equal('2.0.0');

            await db.rollbackReversibleBlocks(orphanedBlock.block_num);
            // What the receiver does next, before it processes the replacement block.
            await processor.notifyFork(db);

            expect(await readMarker()).to.be.null;
            expect(core.v2MarkerBlock).to.be.null;
            expect(core.config.version).to.equal('1.2.2');
            // The gate a canonical action after the fork would be judged by.
            expect(marketDissolvesBundles({
                version: core.config.version,
                markerBlock: core.v2MarkerBlock,
                blockNum: orphanedBlock.block_num + 1
            })).to.be.false;
        } finally {
            await client.query('COMMIT');
            await client.query('DELETE FROM atomicmarket_config WHERE market_contract = $1', [MARKET_CONTRACT]);
            await client.query('DELETE FROM reversible_queries WHERE reader = $1', [READER_NAME]);
            await client.query('DELETE FROM reversible_blocks WHERE reader = $1', [READER_NAME]);
            await client.query('BEGIN');
        }
    });

    it('re-syncs the in-memory marker from the row rather than trusting the last write', async () => {
        // A rollback does not reach into memory, so the processor reads the row.
        const storedMarker = 700;
        await seedConfigRow('2.0.0', storedMarker);
        const core = createMockCore('2.0.0', 999999);

        await applyDelta(core, '2.0.0', createBlock());

        expect(core.v2MarkerBlock).to.equal(storedMarker);
    });

    it('leaves an established marker where it is when a later v2 delta arrives', async () => {
        const flipBlock = 500;
        await seedConfigRow('2.0.0', flipBlock);
        const core = createMockCore('2.0.0', flipBlock);

        await applyDelta(core, '2.1.0', createBlock());

        expect(Number(await readMarker())).to.equal(flipBlock);
        expect(core.v2MarkerBlock).to.equal(flipBlock);
    });
});
