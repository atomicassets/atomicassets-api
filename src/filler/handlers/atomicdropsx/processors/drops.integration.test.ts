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

import { dropsProcessor } from './drops';
import {
    LogNewDropActionData,
    SetDropDataActionData,
    SetDropPriceActionData,
    SetDropLimitActionData,
    SetDropTimeActionData,
    EraseDropActionData,
} from '../types/actions';

const DROPS_CONTRACT = 'atomicdropsx';
const ASSETS_CONTRACT = 'atomicassets';

function createMockCore(overrides: Record<string, any> = {}): any {
    return {
        args: {
            atomicdropsx_account: DROPS_CONTRACT,
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

/** Minimal lognewdrop payload — tests override fields they care about. */
function buildLogNewDrop(overrides: Partial<LogNewDropActionData> & { drop_id: string }): LogNewDropActionData {
    return {
        collection_name: 'testcol11111',
        assets_to_mint: [{ template_id: '101' }],
        listing_price: '5.00000000 WAX',
        price_recipient: 'creatorxxxxx',
        auth_required: false,
        ...overrides,
    };
}

describe('atomicdropsx dropsProcessor', () => {
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
        destroy = dropsProcessor(createMockCore(), processor);
    });

    afterEach(async () => {
        if (destroy) destroy();
        await client.query('ROLLBACK');
    });

    it('lognewdrop parses listing_price "5.00000000 WAX" → amount=500000000 + symbol=WAX', async () => {
        const block = createBlock({ timestamp: '2026-05-15T00:00:00.000' });
        await processActionTrace(processor, db, block, createTx(), createActionTrace(
            DROPS_CONTRACT, 'lognewdrop',
            buildLogNewDrop({ drop_id: '9001' }),
        ));

        const res = await client.query(
            'SELECT * FROM atomicdropsx_drops WHERE contract = $1 AND drop_id = $2',
            [DROPS_CONTRACT, '9001'],
        );
        expect(res.rowCount).to.equal(1);
        const row = res.rows[0];
        expect(row.listing_price).to.equal('500000000');
        expect(row.listing_symbol).to.equal('WAX');
        expect(row.is_deleted).to.equal(false);
        expect(row.assets_contract).to.equal(ASSETS_CONTRACT);
        expect(Number(row.created_at_block)).to.equal(block.block_num);
    });

    it('lognewdrop with empty listing_price stores amount="0"', async () => {
        const block = createBlock();
        await processActionTrace(processor, db, block, createTx(), createActionTrace(
            DROPS_CONTRACT, 'lognewdrop',
            buildLogNewDrop({ drop_id: '9002', listing_price: '' }),
        ));

        const res = await client.query(
            'SELECT listing_price, listing_symbol FROM atomicdropsx_drops ' +
            'WHERE contract = $1 AND drop_id = $2',
            [DROPS_CONTRACT, '9002'],
        );
        expect(res.rowCount).to.equal(1);
        expect(res.rows[0].listing_price).to.equal('0');
        expect(res.rows[0].listing_symbol).to.equal('');
    });

    it('lognewdrop on the same (contract, drop_id) updates in place', async () => {
        const block1 = createBlock({ timestamp: '2026-05-15T00:00:00.000' });
        await processActionTrace(processor, db, block1, createTx(), createActionTrace(
            DROPS_CONTRACT, 'lognewdrop',
            buildLogNewDrop({ drop_id: '9003', listing_price: '1.00000000 WAX', display_data: '{"name":"v1"}' }),
        ));

        const block2 = createBlock({
            timestamp: '2026-05-15T00:01:00.000',
            block_num: block1.block_num + 1,
        });
        await processActionTrace(processor, db, block2, createTx(), createActionTrace(
            DROPS_CONTRACT, 'lognewdrop',
            buildLogNewDrop({ drop_id: '9003', listing_price: '2.00000000 WAX', display_data: '{"name":"v2"}' }),
        ));

        const res = await client.query(
            'SELECT listing_price, display_data, updated_at_block, ' +
            '       (SELECT COUNT(*) FROM atomicdropsx_drops WHERE contract = $1 AND drop_id = $2) AS row_count ' +
            'FROM atomicdropsx_drops WHERE contract = $1 AND drop_id = $2',
            [DROPS_CONTRACT, '9003'],
        );
        expect(res.rowCount).to.equal(1);
        // Single row (upsert, not duplicate insert).
        expect(Number(res.rows[0].row_count)).to.equal(1);
        expect(res.rows[0].listing_price).to.equal('200000000');
        expect(res.rows[0].display_data).to.equal('{"name":"v2"}');
        expect(Number(res.rows[0].updated_at_block)).to.equal(block2.block_num);
    });

    it('setdropdata updates only display_data and updated_at_*', async () => {
        const block1 = createBlock();
        await processActionTrace(processor, db, block1, createTx(), createActionTrace(
            DROPS_CONTRACT, 'lognewdrop',
            buildLogNewDrop({ drop_id: '9004', display_data: '{"name":"original"}' }),
        ));

        const block2 = createBlock({ block_num: block1.block_num + 1 });
        const data: SetDropDataActionData = { drop_id: '9004', display_data: '{"name":"renamed"}' };
        await processActionTrace(processor, db, block2, createTx(), createActionTrace(
            DROPS_CONTRACT, 'setdropdata', data,
        ));

        const res = await client.query(
            'SELECT display_data, listing_price, updated_at_block FROM atomicdropsx_drops ' +
            'WHERE contract = $1 AND drop_id = $2',
            [DROPS_CONTRACT, '9004'],
        );
        expect(res.rowCount).to.equal(1);
        expect(res.rows[0].display_data).to.equal('{"name":"renamed"}');
        // Untouched.
        expect(res.rows[0].listing_price).to.equal('500000000');
        expect(Number(res.rows[0].updated_at_block)).to.equal(block2.block_num);
    });

    it('setdropprice re-parses listing_price and updates symbol', async () => {
        // Seed with WAX listing.
        const block1 = createBlock();
        await processActionTrace(processor, db, block1, createTx(), createActionTrace(
            DROPS_CONTRACT, 'lognewdrop',
            buildLogNewDrop({ drop_id: '9005', listing_price: '5.00000000 WAX' }),
        ));

        // Update to USDC (different precision + symbol).
        const block2 = createBlock({ block_num: block1.block_num + 1 });
        const data: SetDropPriceActionData = { drop_id: '9005', listing_price: '1.000000 USDC' };
        await processActionTrace(processor, db, block2, createTx(), createActionTrace(
            DROPS_CONTRACT, 'setdropprice', data,
        ));

        const res = await client.query(
            'SELECT listing_price, listing_symbol FROM atomicdropsx_drops ' +
            'WHERE contract = $1 AND drop_id = $2',
            [DROPS_CONTRACT, '9005'],
        );
        expect(res.rowCount).to.equal(1);
        expect(res.rows[0].listing_price).to.equal('1000000');
        expect(res.rows[0].listing_symbol).to.equal('USDC');
    });

    it('setdroplimit updates account_limit, account_limit_cooldown, and max_claimable', async () => {
        const block1 = createBlock();
        await processActionTrace(processor, db, block1, createTx(), createActionTrace(
            DROPS_CONTRACT, 'lognewdrop',
            buildLogNewDrop({ drop_id: '9006', account_limit: 1, max_claimable: 100 }),
        ));

        const block2 = createBlock({ block_num: block1.block_num + 1 });
        const data: SetDropLimitActionData = {
            drop_id: '9006',
            account_limit: 5,
            account_limit_cooldown: 3600,
            max_claimable: 1000,
        };
        await processActionTrace(processor, db, block2, createTx(), createActionTrace(
            DROPS_CONTRACT, 'setdroplimit', data,
        ));

        const res = await client.query(
            'SELECT account_limit, account_limit_cooldown, max_claimable FROM atomicdropsx_drops ' +
            'WHERE contract = $1 AND drop_id = $2',
            [DROPS_CONTRACT, '9006'],
        );
        expect(res.rowCount).to.equal(1);
        expect(Number(res.rows[0].account_limit)).to.equal(5);
        expect(Number(res.rows[0].account_limit_cooldown)).to.equal(3600);
        expect(Number(res.rows[0].max_claimable)).to.equal(1000);
    });

    it('setdroptime with only start_time set leaves end_time untouched', async () => {
        const block1 = createBlock();
        await processActionTrace(processor, db, block1, createTx(), createActionTrace(
            DROPS_CONTRACT, 'lognewdrop',
            buildLogNewDrop({ drop_id: '9007', start_time: 1000, end_time: 5000 }),
        ));

        const block2 = createBlock({ block_num: block1.block_num + 1 });
        const data: SetDropTimeActionData = { drop_id: '9007', start_time: 2000 };
        await processActionTrace(processor, db, block2, createTx(), createActionTrace(
            DROPS_CONTRACT, 'setdroptime', data,
        ));

        const res = await client.query(
            'SELECT start_time, end_time FROM atomicdropsx_drops ' +
            'WHERE contract = $1 AND drop_id = $2',
            [DROPS_CONTRACT, '9007'],
        );
        expect(res.rowCount).to.equal(1);
        expect(Number(res.rows[0].start_time)).to.equal(2000);
        // end_time NOT in the action payload → must stay 5000.
        expect(Number(res.rows[0].end_time)).to.equal(5000);
    });

    it('setdroptime with only end_time set leaves start_time untouched', async () => {
        const block1 = createBlock();
        await processActionTrace(processor, db, block1, createTx(), createActionTrace(
            DROPS_CONTRACT, 'lognewdrop',
            buildLogNewDrop({ drop_id: '9008', start_time: 1000, end_time: 5000 }),
        ));

        const block2 = createBlock({ block_num: block1.block_num + 1 });
        const data: SetDropTimeActionData = { drop_id: '9008', end_time: 9000 };
        await processActionTrace(processor, db, block2, createTx(), createActionTrace(
            DROPS_CONTRACT, 'setdroptime', data,
        ));

        const res = await client.query(
            'SELECT start_time, end_time FROM atomicdropsx_drops ' +
            'WHERE contract = $1 AND drop_id = $2',
            [DROPS_CONTRACT, '9008'],
        );
        expect(res.rowCount).to.equal(1);
        // start_time NOT in the action payload → must stay 1000.
        expect(Number(res.rows[0].start_time)).to.equal(1000);
        expect(Number(res.rows[0].end_time)).to.equal(9000);
    });

    it('erasedrop sets is_deleted=true', async () => {
        const block1 = createBlock();
        await processActionTrace(processor, db, block1, createTx(), createActionTrace(
            DROPS_CONTRACT, 'lognewdrop',
            buildLogNewDrop({ drop_id: '9009' }),
        ));

        const block2 = createBlock({ block_num: block1.block_num + 1 });
        const data: EraseDropActionData = { drop_id: '9009' };
        await processActionTrace(processor, db, block2, createTx(), createActionTrace(
            DROPS_CONTRACT, 'erasedrop', data,
        ));

        const res = await client.query(
            'SELECT is_deleted, updated_at_block FROM atomicdropsx_drops ' +
            'WHERE contract = $1 AND drop_id = $2',
            [DROPS_CONTRACT, '9009'],
        );
        expect(res.rowCount).to.equal(1);
        expect(res.rows[0].is_deleted).to.equal(true);
        expect(Number(res.rows[0].updated_at_block)).to.equal(block2.block_num);
    });
});
