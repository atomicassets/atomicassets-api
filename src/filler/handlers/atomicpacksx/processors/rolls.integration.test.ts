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
    AddPackRollActionData,
    LogNewRollActionData,
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
    // @ts-ignore - test-only construction matches atomicmarket pattern.
    loader.modules = [];
    // @ts-ignore
    loader.names = [];
    return loader;
}

/**
 * pack_rolls FK references atomicpacksx_packs(contract, pack_id) so every
 * test must seed a parent pack row first.
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

describe('atomicpacksx rollsProcessor (WAX ABI: lognewroll + addpackroll)', () => {
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

    it('lognewroll inserts a placeholder row with empty outcomes', async () => {
        await seedPack(client, '6001');

        const data: LogNewRollActionData = { pack_id: '6001', roll_id: '0' };
        await processActionTrace(processor, db, createBlock(), createTx(), createActionTrace(PACKS_CONTRACT, 'lognewroll', data));

        const res = await client.query(
            'SELECT total_odds, outcomes FROM atomicpacksx_pack_rolls WHERE contract = $1 AND pack_id = $2 AND roll_index = $3',
            [PACKS_CONTRACT, '6001', '0'],
        );
        expect(res.rowCount).to.equal(1);
        expect(res.rows[0].total_odds).to.equal('0');
        expect(res.rows[0].outcomes).to.deep.equal([]);
    });

    it('addpackroll fills total_odds + outcomes on the most-recent placeholder roll for the pack', async () => {
        await seedPack(client, '6002');

        // 1. lognewroll creates the placeholder
        await processActionTrace(processor, db, createBlock(), createTx(), createActionTrace<LogNewRollActionData>(
            PACKS_CONTRACT, 'lognewroll',
            { pack_id: '6002', roll_id: '0' },
        ));

        // 2. addpackroll fills it in
        const outcomes = [{ template_id: '101', odds: '70' }, { template_id: '102', odds: '30' }];
        const data: AddPackRollActionData = {
            authorized_account: 'creator11111',
            pack_id: '6002',
            outcomes,
            total_odds: '100',
        };
        await processActionTrace(processor, db, createBlock(), createTx(), createActionTrace(PACKS_CONTRACT, 'addpackroll', data));

        const res = await client.query(
            'SELECT total_odds, outcomes FROM atomicpacksx_pack_rolls WHERE contract = $1 AND pack_id = $2 AND roll_index = $3',
            [PACKS_CONTRACT, '6002', '0'],
        );
        expect(res.rowCount).to.equal(1);
        expect(res.rows[0].total_odds).to.equal('100');
        expect(res.rows[0].outcomes).to.deep.equal(outcomes);
    });

    it('lognewroll → addpackroll → lognewroll (roll 1) → addpackroll fills each correctly', async () => {
        await seedPack(client, '6003');

        // Roll 0: announce + fill
        await processActionTrace(processor, db, createBlock(), createTx(), createActionTrace<LogNewRollActionData>(
            PACKS_CONTRACT, 'lognewroll',
            { pack_id: '6003', roll_id: '0' },
        ));
        await processActionTrace(processor, db, createBlock(), createTx(), createActionTrace<AddPackRollActionData>(
            PACKS_CONTRACT, 'addpackroll',
            { authorized_account: 'a', pack_id: '6003', outcomes: [{ template_id: '201', odds: '100' }], total_odds: '100' },
        ));

        // Roll 1: announce + fill (different outcomes)
        await processActionTrace(processor, db, createBlock(), createTx(), createActionTrace<LogNewRollActionData>(
            PACKS_CONTRACT, 'lognewroll',
            { pack_id: '6003', roll_id: '1' },
        ));
        await processActionTrace(processor, db, createBlock(), createTx(), createActionTrace<AddPackRollActionData>(
            PACKS_CONTRACT, 'addpackroll',
            { authorized_account: 'a', pack_id: '6003', outcomes: [{ template_id: '202', odds: '50' }, { template_id: '203', odds: '50' }], total_odds: '100' },
        ));

        const res = await client.query(
            'SELECT roll_index, total_odds, outcomes FROM atomicpacksx_pack_rolls ' +
            'WHERE contract = $1 AND pack_id = $2 ORDER BY roll_index',
            [PACKS_CONTRACT, '6003'],
        );
        expect(res.rowCount).to.equal(2);
        expect(res.rows[0].outcomes).to.deep.equal([{ template_id: '201', odds: '100' }]);
        expect(res.rows[1].outcomes).to.deep.equal([{ template_id: '202', odds: '50' }, { template_id: '203', odds: '50' }]);
    });

    it('addpackroll without a preceding lognewroll is a silent no-op (no row inserted)', async () => {
        await seedPack(client, '6004');

        await processActionTrace(processor, db, createBlock(), createTx(), createActionTrace<AddPackRollActionData>(
            PACKS_CONTRACT, 'addpackroll',
            { authorized_account: 'a', pack_id: '6004', outcomes: [{ template_id: '301', odds: '100' }], total_odds: '100' },
        ));

        const res = await client.query(
            'SELECT count(*) AS n FROM atomicpacksx_pack_rolls WHERE contract = $1 AND pack_id = $2',
            [PACKS_CONTRACT, '6004'],
        );
        expect(Number(res.rows[0].n)).to.equal(0);
    });
});
