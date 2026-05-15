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
    CompletePackActionData,
    LogNewPackActionData,
    SetPackDataActionData,
    SetPackTimeActionData,
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

describe('atomicpacksx packsProcessor (WAX ABI)', () => {
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

    it('lognewpack inserts a row with NULL pack_template_id and NULL display_data (filled later)', async () => {
        const block = createBlock({ timestamp: '2026-05-15T00:00:00.000' });
        const data: LogNewPackActionData = {
            pack_id: '5001',
            collection_name: 'testcol11111',
            unlock_time: 1747526400,
        };
        await processActionTrace(processor, db, block, createTx(), createActionTrace(PACKS_CONTRACT, 'lognewpack', data));

        const res = await client.query(
            'SELECT * FROM atomicpacksx_packs WHERE contract = $1 AND pack_id = $2',
            [PACKS_CONTRACT, '5001'],
        );
        expect(res.rowCount).to.equal(1);
        const row = res.rows[0];
        expect(row.collection_name).to.equal('testcol11111');
        expect(row.pack_template_id).to.be.null;   // populated by completepack
        expect(row.display_data).to.be.null;       // populated by setpackdata
        expect(Number(row.unlock_time)).to.equal(1747526400);
        expect(row.assets_contract).to.equal(ASSETS_CONTRACT);
    });

    it('completepack sets pack_template_id on an existing pack row', async () => {
        const block1 = createBlock();
        await processActionTrace(processor, db, block1, createTx(), createActionTrace<LogNewPackActionData>(
            PACKS_CONTRACT, 'lognewpack',
            { pack_id: '5002', collection_name: 'testcol11111', unlock_time: 1747526400 },
        ));

        const block2 = createBlock({ block_num: block1.block_num + 1 });
        const data: CompletePackActionData = {
            authorized_account: 'creator11111',
            pack_id: '5002',
            pack_template_id: '700',
        };
        await processActionTrace(processor, db, block2, createTx(), createActionTrace(PACKS_CONTRACT, 'completepack', data));

        const res = await client.query(
            'SELECT pack_template_id, updated_at_block FROM atomicpacksx_packs WHERE contract = $1 AND pack_id = $2',
            [PACKS_CONTRACT, '5002'],
        );
        expect(res.rowCount).to.equal(1);
        expect(res.rows[0].pack_template_id).to.equal('700');
        expect(Number(res.rows[0].updated_at_block)).to.equal(block2.block_num);
    });

    it('setpackdata updates display_data only (tolerates extra authorized_account field)', async () => {
        const block1 = createBlock();
        await processActionTrace(processor, db, block1, createTx(), createActionTrace<LogNewPackActionData>(
            PACKS_CONTRACT, 'lognewpack',
            { pack_id: '5003', collection_name: 'testcol11111', unlock_time: 1747526400 },
        ));

        const block2 = createBlock({ block_num: block1.block_num + 1 });
        const data: SetPackDataActionData = {
            authorized_account: 'creator11111',
            pack_id: '5003',
            display_data: '{"name":"Mythic Pack"}',
        };
        await processActionTrace(processor, db, block2, createTx(), createActionTrace(PACKS_CONTRACT, 'setpackdata', data));

        const res = await client.query(
            'SELECT display_data, unlock_time, updated_at_block FROM atomicpacksx_packs ' +
            'WHERE contract = $1 AND pack_id = $2',
            [PACKS_CONTRACT, '5003'],
        );
        expect(res.rowCount).to.equal(1);
        expect(res.rows[0].display_data).to.equal('{"name":"Mythic Pack"}');
        expect(Number(res.rows[0].unlock_time)).to.equal(1747526400);  // untouched
        expect(Number(res.rows[0].updated_at_block)).to.equal(block2.block_num);
    });

    it('setpacktime updates unlock_time using new_unlock_time field (WAX ABI)', async () => {
        const block1 = createBlock();
        await processActionTrace(processor, db, block1, createTx(), createActionTrace<LogNewPackActionData>(
            PACKS_CONTRACT, 'lognewpack',
            { pack_id: '5004', collection_name: 'testcol11111', unlock_time: 1747526400 },
        ));

        const block2 = createBlock({ block_num: block1.block_num + 1 });
        const data: SetPackTimeActionData = {
            authorized_account: 'creator11111',
            pack_id: '5004',
            new_unlock_time: 1747700000,
        };
        await processActionTrace(processor, db, block2, createTx(), createActionTrace(PACKS_CONTRACT, 'setpacktime', data));

        const res = await client.query(
            'SELECT unlock_time, updated_at_block FROM atomicpacksx_packs ' +
            'WHERE contract = $1 AND pack_id = $2',
            [PACKS_CONTRACT, '5004'],
        );
        expect(res.rowCount).to.equal(1);
        expect(Number(res.rows[0].unlock_time)).to.equal(1747700000);
        expect(Number(res.rows[0].updated_at_block)).to.equal(block2.block_num);
    });

    it('announcepack is a no-op (info already covered by lognewpack + setpackdata in same tx)', async () => {
        const block = createBlock();
        await processActionTrace(processor, db, block, createTx(), createActionTrace(
            PACKS_CONTRACT, 'announcepack',
            { authorized_account: 'creator11111', collection_name: 'testcol11111', unlock_time: 1747526400, display_data: '{"name":"Mystery Pack"}' },
        ));

        const res = await client.query('SELECT count(*) AS n FROM atomicpacksx_packs');
        expect(Number(res.rows[0].n)).to.equal(0);  // no row inserted (pack_id unknown)
    });
});
