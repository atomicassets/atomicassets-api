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

import { packsProcessor } from './packs';
import {
    LogNewPackActionData,
    SetPackDataActionData,
    SetUnlockTimeActionData,
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

describe('atomicpacksx packsProcessor', () => {
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
        destroy = packsProcessor(createMockCore(), processor);
    });

    afterEach(async () => {
        if (destroy) destroy();
        await client.query('ROLLBACK');
    });

    it('lognewpack inserts a row in atomicpacksx_packs with display_data + unlock_time', async () => {
        const block = createBlock({ timestamp: '2026-05-15T00:00:00.000' });
        const tx = createTx();
        const data: LogNewPackActionData = {
            pack_id: '5001',
            collection_name: 'testcol11111',
            pack_template_id: '700',
            unlock_time: 1747526400000,
            display_data: '{"name":"Mythic Pack","img":"QmHash"}',
        };
        await processActionTrace(processor, db, block, tx, createActionTrace(PACKS_CONTRACT, 'lognewpack', data));

        const res = await client.query(
            'SELECT * FROM atomicpacksx_packs WHERE contract = $1 AND pack_id = $2',
            [PACKS_CONTRACT, '5001'],
        );
        expect(res.rowCount).to.equal(1);
        const row = res.rows[0];
        expect(row.collection_name).to.equal('testcol11111');
        expect(row.pack_template_id).to.equal('700');
        expect(Number(row.unlock_time)).to.equal(1747526400000);
        expect(row.display_data).to.equal('{"name":"Mythic Pack","img":"QmHash"}');
        expect(row.assets_contract).to.equal(ASSETS_CONTRACT);
        expect(Number(row.created_at_block)).to.equal(block.block_num);
        expect(Number(row.updated_at_block)).to.equal(block.block_num);
    });

    it('lognewpack on the same (contract, pack_id) updates in place', async () => {
        // First insert.
        const block1 = createBlock({ timestamp: '2026-05-15T00:00:00.000' });
        await processActionTrace(processor, db, block1, createTx(), createActionTrace<LogNewPackActionData>(
            PACKS_CONTRACT, 'lognewpack',
            {
                pack_id: '5002',
                collection_name: 'testcol11111',
                pack_template_id: '701',
                unlock_time: 1747526400000,
                display_data: '{"name":"Original"}',
            },
        ));

        // Second insert with same pack_id, new display_data + later block.
        const block2 = createBlock({
            timestamp: '2026-05-15T00:01:00.000',
            block_num: block1.block_num + 1,
        });
        await processActionTrace(processor, db, block2, createTx(), createActionTrace<LogNewPackActionData>(
            PACKS_CONTRACT, 'lognewpack',
            {
                pack_id: '5002',
                collection_name: 'testcol11111',
                pack_template_id: '701',
                unlock_time: 1747612800000,
                display_data: '{"name":"Updated"}',
            },
        ));

        const res = await client.query(
            'SELECT display_data, unlock_time, updated_at_block, ' +
            '       (SELECT COUNT(*) FROM atomicpacksx_packs WHERE contract = $1 AND pack_id = $2) AS row_count ' +
            'FROM atomicpacksx_packs WHERE contract = $1 AND pack_id = $2',
            [PACKS_CONTRACT, '5002'],
        );
        expect(res.rowCount).to.equal(1);
        const row = res.rows[0];
        // Single row (no duplicate insert).
        expect(Number(row.row_count)).to.equal(1);
        expect(row.display_data).to.equal('{"name":"Updated"}');
        expect(Number(row.unlock_time)).to.equal(1747612800000);
        expect(Number(row.updated_at_block)).to.equal(block2.block_num);
    });

    it('setpackdata updates display_data and updated_at_* but leaves unlock_time alone', async () => {
        const block1 = createBlock({ timestamp: '2026-05-15T00:00:00.000' });
        await processActionTrace(processor, db, block1, createTx(), createActionTrace<LogNewPackActionData>(
            PACKS_CONTRACT, 'lognewpack',
            {
                pack_id: '5003',
                collection_name: 'testcol11111',
                pack_template_id: '702',
                unlock_time: 1747526400000,
                display_data: '{"name":"Initial"}',
            },
        ));

        const block2 = createBlock({
            timestamp: '2026-05-15T00:01:00.000',
            block_num: block1.block_num + 1,
        });
        const data: SetPackDataActionData = {
            pack_id: '5003',
            display_data: '{"name":"Renamed","img":"QmNewHash"}',
        };
        await processActionTrace(processor, db, block2, createTx(), createActionTrace(PACKS_CONTRACT, 'setpackdata', data));

        const res = await client.query(
            'SELECT display_data, unlock_time, updated_at_block FROM atomicpacksx_packs ' +
            'WHERE contract = $1 AND pack_id = $2',
            [PACKS_CONTRACT, '5003'],
        );
        expect(res.rowCount).to.equal(1);
        expect(res.rows[0].display_data).to.equal('{"name":"Renamed","img":"QmNewHash"}');
        // unlock_time untouched by setpackdata.
        expect(Number(res.rows[0].unlock_time)).to.equal(1747526400000);
        expect(Number(res.rows[0].updated_at_block)).to.equal(block2.block_num);
    });

    it('setunlocktime updates unlock_time and updated_at_* but leaves display_data alone', async () => {
        const block1 = createBlock({ timestamp: '2026-05-15T00:00:00.000' });
        await processActionTrace(processor, db, block1, createTx(), createActionTrace<LogNewPackActionData>(
            PACKS_CONTRACT, 'lognewpack',
            {
                pack_id: '5004',
                collection_name: 'testcol11111',
                pack_template_id: '703',
                unlock_time: 1747526400000,
                display_data: '{"name":"Locked"}',
            },
        ));

        const block2 = createBlock({
            timestamp: '2026-05-15T00:01:00.000',
            block_num: block1.block_num + 1,
        });
        const data: SetUnlockTimeActionData = {
            pack_id: '5004',
            unlock_time: 1747700000000,
        };
        await processActionTrace(processor, db, block2, createTx(), createActionTrace(PACKS_CONTRACT, 'setunlocktime', data));

        const res = await client.query(
            'SELECT display_data, unlock_time, updated_at_block FROM atomicpacksx_packs ' +
            'WHERE contract = $1 AND pack_id = $2',
            [PACKS_CONTRACT, '5004'],
        );
        expect(res.rowCount).to.equal(1);
        // display_data untouched by setunlocktime.
        expect(res.rows[0].display_data).to.equal('{"name":"Locked"}');
        expect(Number(res.rows[0].unlock_time)).to.equal(1747700000000);
        expect(Number(res.rows[0].updated_at_block)).to.equal(block2.block_num);
    });
});
