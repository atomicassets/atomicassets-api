import 'mocha';
import { expect } from 'chai';
import { Client } from 'pg';

import {
    createProcessorTestContext,
    createBlock,
    createTx,
    createActionTrace,
    processActionTrace,
    createTestTransaction,
} from '../../test-helper';
import { ModuleLoader } from '../../../modules';
import DataProcessor, { ProcessingState } from '../../../processor';
import { ContractDBTransaction } from '../../../database';

import { rollsProcessor } from './rolls';
import {
    LogNewRollActionData,
    SetRollOutcomesActionData,
} from '../types/actions';

const PACKS_CONTRACT = 'atomicpacksx';
const ASSETS_CONTRACT = 'atomicassets';

function createMockCore(overrides: Record<string, any> = {}): any {
    return {
        args: {
            atomicpacksx_account: PACKS_CONTRACT,
            atomicassets_account: ASSETS_CONTRACT,
            store_logs: false,
            ...overrides,
        },
    };
}

function createMockModuleLoader(): ModuleLoader {
    const loader = Object.create(ModuleLoader.prototype) as ModuleLoader;
    // @ts-ignore — test-only construction matches atomicmarket pattern.
    loader.modules = [];
    // @ts-ignore
    loader.names = [];
    return loader;
}

/**
 * pack_rolls FK references atomicpacksx_packs(contract, pack_id) so every
 * test must have a parent pack row. seedPack creates one with minimal
 * fields; tests that need pack-specific values can override.
 */
async function seedPack(client: Client, packId: string): Promise<void> {
    await client.query(
        `INSERT INTO atomicpacksx_packs (
            contract, pack_id, assets_contract, collection_name, pack_template_id,
            unlock_time, display_data,
            created_at_block, created_at_time, updated_at_block, updated_at_time
        ) VALUES ($1, $2, $3, 'testcol11111', NULL, NULL, NULL, 100, 1000, 100, 1000)`,
        [PACKS_CONTRACT, packId, ASSETS_CONTRACT],
    );
}

describe('atomicpacksx rollsProcessor', () => {
    let client: Client;
    let processor: DataProcessor;
    let db: ContractDBTransaction;
    let destroy: () => any;

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
        destroy = rollsProcessor(createMockCore(), processor);
    });

    afterEach(async () => {
        if (destroy) destroy();
        await client.query('ROLLBACK');
    });

    it('lognewroll inserts a row keyed on (contract, pack_id, roll_index)', async () => {
        await seedPack(client, '6001');

        const block = createBlock({ timestamp: '2026-05-15T00:00:00.000' });
        const tx = createTx();
        const outcomes = [
            { template_id: '101', odds: '50' },
            { template_id: '102', odds: '50' },
        ];
        const data: LogNewRollActionData = {
            pack_id: '6001',
            roll_id: '0',
            total_odds: '100',
            outcomes,
            display_data: '{"label":"Common Roll"}',
        };
        await processActionTrace(processor, db, block, tx, createActionTrace(PACKS_CONTRACT, 'lognewroll', data));

        const res = await client.query(
            'SELECT * FROM atomicpacksx_pack_rolls WHERE contract = $1 AND pack_id = $2 AND roll_index = $3',
            [PACKS_CONTRACT, '6001', '0'],
        );
        expect(res.rowCount).to.equal(1);
        const row = res.rows[0];
        expect(row.total_odds).to.equal('100');
        expect(row.display_data).to.equal('{"label":"Common Roll"}');
        expect(Number(row.created_at_block)).to.equal(block.block_num);
    });

    it('lognewroll serializes outcomes as JSON (round-trips deep-equal)', async () => {
        await seedPack(client, '6002');

        const outcomes = [
            { template_id: '201', odds: '70' },
            { template_id: '202', odds: '25' },
            { template_id: '203', odds: '5' },
        ];
        await processActionTrace(processor, db, createBlock(), createTx(), createActionTrace<LogNewRollActionData>(
            PACKS_CONTRACT, 'lognewroll',
            { pack_id: '6002', roll_id: '0', total_odds: '100', outcomes },
        ));

        const res = await client.query(
            'SELECT outcomes FROM atomicpacksx_pack_rolls WHERE contract = $1 AND pack_id = $2 AND roll_index = $3',
            [PACKS_CONTRACT, '6002', '0'],
        );
        expect(res.rowCount).to.equal(1);
        // outcomes is a jsonb column; pg's default type-parser auto-decodes
        // it into a JS array. Compare structurally without re-parsing.
        expect(res.rows[0].outcomes).to.deep.equal(outcomes);
    });

    it('lognewroll on an existing (pack_id, roll_id) updates total_odds + outcomes', async () => {
        await seedPack(client, '6003');

        // First insert.
        const block1 = createBlock();
        await processActionTrace(processor, db, block1, createTx(), createActionTrace<LogNewRollActionData>(
            PACKS_CONTRACT, 'lognewroll',
            { pack_id: '6003', roll_id: '0', total_odds: '100', outcomes: [{ template_id: '301', odds: '100' }] },
        ));

        // Second insert with same key, new values.
        const block2 = createBlock({ block_num: block1.block_num + 1 });
        const newOutcomes = [{ template_id: '302', odds: '60' }, { template_id: '303', odds: '40' }];
        await processActionTrace(processor, db, block2, createTx(), createActionTrace<LogNewRollActionData>(
            PACKS_CONTRACT, 'lognewroll',
            { pack_id: '6003', roll_id: '0', total_odds: '200', outcomes: newOutcomes },
        ));

        const res = await client.query(
            'SELECT total_odds, outcomes, updated_at_block, ' +
            '       (SELECT COUNT(*) FROM atomicpacksx_pack_rolls ' +
            '          WHERE contract = $1 AND pack_id = $2 AND roll_index = $3) AS row_count ' +
            'FROM atomicpacksx_pack_rolls WHERE contract = $1 AND pack_id = $2 AND roll_index = $3',
            [PACKS_CONTRACT, '6003', '0'],
        );
        expect(res.rowCount).to.equal(1);
        // Single row (upsert, not duplicate insert).
        expect(Number(res.rows[0].row_count)).to.equal(1);
        expect(res.rows[0].total_odds).to.equal('200');
        expect(res.rows[0].outcomes).to.deep.equal(newOutcomes);
        expect(Number(res.rows[0].updated_at_block)).to.equal(block2.block_num);
    });

    it('setrolloutcomes updates total_odds + outcomes for the matching roll', async () => {
        await seedPack(client, '6004');

        // Seed via lognewroll first so the row exists.
        const block1 = createBlock();
        await processActionTrace(processor, db, block1, createTx(), createActionTrace<LogNewRollActionData>(
            PACKS_CONTRACT, 'lognewroll',
            { pack_id: '6004', roll_id: '0', total_odds: '100', outcomes: [{ template_id: '401', odds: '100' }] },
        ));

        const block2 = createBlock({ block_num: block1.block_num + 1 });
        const updated = [{ template_id: '401', odds: '50' }, { template_id: '402', odds: '50' }];
        const data: SetRollOutcomesActionData = {
            pack_id: '6004',
            roll_id: '0',
            total_odds: '100',
            outcomes: updated,
        };
        await processActionTrace(processor, db, block2, createTx(), createActionTrace(PACKS_CONTRACT, 'setrolloutcomes', data));

        const res = await client.query(
            'SELECT total_odds, outcomes, updated_at_block FROM atomicpacksx_pack_rolls ' +
            'WHERE contract = $1 AND pack_id = $2 AND roll_index = $3',
            [PACKS_CONTRACT, '6004', '0'],
        );
        expect(res.rowCount).to.equal(1);
        expect(res.rows[0].total_odds).to.equal('100');
        // jsonb column — already deserialized by pg.
        expect(res.rows[0].outcomes).to.deep.equal(updated);
        expect(Number(res.rows[0].updated_at_block)).to.equal(block2.block_num);
    });

    it('setrolloutcomes is a no-op when (pack_id, roll_id) does not exist', async () => {
        await seedPack(client, '6005');

        const data: SetRollOutcomesActionData = {
            pack_id: '6005',
            // No matching roll_id was ever inserted; UPDATE should affect 0 rows.
            roll_id: '99',
            total_odds: '100',
            outcomes: [{ template_id: '999', odds: '100' }],
        };
        await processActionTrace(processor, db, createBlock(), createTx(), createActionTrace(PACKS_CONTRACT, 'setrolloutcomes', data));

        const res = await client.query(
            'SELECT COUNT(*) AS n FROM atomicpacksx_pack_rolls ' +
            'WHERE contract = $1 AND pack_id = $2 AND roll_index = $3',
            [PACKS_CONTRACT, '6005', '99'],
        );
        expect(Number(res.rows[0].n)).to.equal(0);
    });
});
