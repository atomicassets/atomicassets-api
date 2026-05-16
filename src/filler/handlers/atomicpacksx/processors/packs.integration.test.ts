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
import { ModuleLoader } from '../../../modules';
import DataProcessor, { ProcessingState } from '../../../processor';
import { ContractDBTransaction } from '../../../database';

import { packsProcessor } from './packs';
import { PacksTableRow } from '../types/tables';

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

function packsRow(overrides: Partial<PacksTableRow> = {}): PacksTableRow {
    return {
        pack_id: '5001',
        collection_name: 'testcol11111',
        unlock_time: 1747526400,
        pack_template_id: -1,           // -1 = announced, not completed
        roll_counter: 0,
        display_data: '',
        ...overrides,
    };
}

describe('atomicpacksx packsProcessor (1.6.0 — onContractRow driven)', () => {
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

    it('packs row INSERT with template_id=-1 stores NULL pack_template_id (pre-completepack state)', async () => {
        const block = createBlock({ timestamp: '2026-05-15T00:00:00.000' });
        const delta = createContractRow(PACKS_CONTRACT, 'packs', packsRow({ pack_id: '5001' }));
        await processContractRow(processor, db, block, delta);

        const res = await client.query(
            'SELECT * FROM atomicpacksx_packs WHERE contract = $1 AND pack_id = $2',
            [PACKS_CONTRACT, '5001'],
        );
        expect(res.rowCount).to.equal(1);
        const row = res.rows[0];
        expect(row.collection_name).to.equal('testcol11111');
        expect(row.pack_template_id).to.be.null;
        expect(row.display_data).to.be.null;
        expect(Number(row.unlock_time)).to.equal(1747526400);
        expect(row.assets_contract).to.equal(ASSETS_CONTRACT);
    });

    it('packs row UPDATE (post-completepack) backfills pack_template_id and updates updated_at_block', async () => {
        const block1 = createBlock();
        await processContractRow(processor, db, block1, createContractRow(
            PACKS_CONTRACT, 'packs', packsRow({ pack_id: '5002' }),
        ));

        const block2 = createBlock({ block_num: block1.block_num + 1 });
        await processContractRow(processor, db, block2, createContractRow(
            PACKS_CONTRACT, 'packs', packsRow({ pack_id: '5002', pack_template_id: '700' }),
        ));

        const res = await client.query(
            'SELECT pack_template_id, created_at_block, updated_at_block FROM atomicpacksx_packs WHERE contract = $1 AND pack_id = $2',
            [PACKS_CONTRACT, '5002'],
        );
        expect(res.rowCount).to.equal(1);
        expect(res.rows[0].pack_template_id).to.equal('700');
        expect(Number(res.rows[0].created_at_block)).to.equal(block1.block_num);
        expect(Number(res.rows[0].updated_at_block)).to.equal(block2.block_num);
    });

    it('packs row UPDATE preserves created_at_block (blacklist guard)', async () => {
        const block1 = createBlock();
        await processContractRow(processor, db, block1, createContractRow(
            PACKS_CONTRACT, 'packs', packsRow({ pack_id: '5003' }),
        ));

        // setpackdata-equivalent re-emit: same row content, just display_data changes
        const block2 = createBlock({ block_num: block1.block_num + 5 });
        await processContractRow(processor, db, block2, createContractRow(
            PACKS_CONTRACT, 'packs', packsRow({ pack_id: '5003', display_data: '{"name":"Mythic"}' }),
        ));

        const res = await client.query(
            'SELECT display_data, created_at_block FROM atomicpacksx_packs WHERE contract = $1 AND pack_id = $2',
            [PACKS_CONTRACT, '5003'],
        );
        expect(res.rows[0].display_data).to.equal('{"name":"Mythic"}');
        expect(Number(res.rows[0].created_at_block)).to.equal(block1.block_num);
    });

    it('packs row UPDATE with new unlock_time (setpacktime-equivalent)', async () => {
        const block1 = createBlock();
        await processContractRow(processor, db, block1, createContractRow(
            PACKS_CONTRACT, 'packs', packsRow({ pack_id: '5004' }),
        ));

        const block2 = createBlock({ block_num: block1.block_num + 1 });
        await processContractRow(processor, db, block2, createContractRow(
            PACKS_CONTRACT, 'packs', packsRow({ pack_id: '5004', unlock_time: 1747700000 }),
        ));

        const res = await client.query(
            'SELECT unlock_time FROM atomicpacksx_packs WHERE contract = $1 AND pack_id = $2',
            [PACKS_CONTRACT, '5004'],
        );
        expect(Number(res.rows[0].unlock_time)).to.equal(1747700000);
    });

    it('packs row DELETE removes the row', async () => {
        const block1 = createBlock();
        await processContractRow(processor, db, block1, createContractRow(
            PACKS_CONTRACT, 'packs', packsRow({ pack_id: '5005' }),
        ));

        const block2 = createBlock({ block_num: block1.block_num + 1 });
        await processContractRow(processor, db, block2, createContractRow(
            PACKS_CONTRACT, 'packs', packsRow({ pack_id: '5005' }), false,
        ));

        const res = await client.query(
            'SELECT count(*) AS n FROM atomicpacksx_packs WHERE contract = $1 AND pack_id = $2',
            [PACKS_CONTRACT, '5005'],
        );
        expect(Number(res.rows[0].n)).to.equal(0);
    });
});
