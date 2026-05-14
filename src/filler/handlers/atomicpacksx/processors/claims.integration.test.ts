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

import { claimsProcessor } from './claims';
import { ClaimState } from '../index';
import {
    LogClaimActionData,
    LogResultActionData,
    CancelClaimActionData,
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

describe('atomicpacksx claimsProcessor', () => {
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
        destroy = claimsProcessor(createMockCore(), processor);
    });

    afterEach(async () => {
        if (destroy) destroy();
        await client.query('ROLLBACK');
    });

    it('logclaim inserts a claim row in CLAIMED state with the tx id', async () => {
        await seedPack(client, '7001');

        const block = createBlock({ timestamp: '2026-05-14T00:00:00.000' });
        const tx = createTx();
        const data: LogClaimActionData = {
            claim_id: '900001',
            pack_id: '7001',
            opener: 'opener111111',
            pack_asset_id: '1099999000001',
        };
        const trace = createActionTrace(PACKS_CONTRACT, 'logclaim', data);

        await processActionTrace(processor, db, block, tx, trace);

        const res = await client.query(
            'SELECT * FROM atomicpacksx_claims WHERE contract = $1 AND claim_id = $2',
            [PACKS_CONTRACT, '900001'],
        );
        expect(res.rowCount).to.equal(1);
        const row = res.rows[0];
        expect(row.pack_id).to.equal('7001');
        expect(row.opener).to.equal('opener111111');
        expect(row.state).to.equal(ClaimState.CLAIMED.valueOf());
        expect(row.txid).to.deep.equal(Buffer.from(tx.id, 'hex'));
        expect(Number(row.claimed_at_block)).to.equal(block.block_num);
        expect(row.resolved_at_block).to.be.null;
    });

    it('logresult transitions to RESOLVED and inserts 1-based claim_assets rows', async () => {
        await seedPack(client, '7002');

        // First seed a claim via logclaim, then resolve it.
        const block1 = createBlock({ timestamp: '2026-05-14T00:00:00.000' });
        const tx1 = createTx();
        await processActionTrace(processor, db, block1, tx1, createActionTrace<LogClaimActionData>(
            PACKS_CONTRACT, 'logclaim',
            { claim_id: '900002', pack_id: '7002', opener: 'opener222222', pack_asset_id: '1099999000002' },
        ));

        const block2 = createBlock({ timestamp: '2026-05-14T00:01:00.000', block_num: block1.block_num + 1 });
        const tx2 = createTx();
        const result: LogResultActionData = { claim_id: '900002', asset_ids: ['2001', '2002', '2003'] };
        await processActionTrace(processor, db, block2, tx2, createActionTrace(PACKS_CONTRACT, 'logresult', result));

        const claim = await client.query(
            'SELECT state, resolved_at_block FROM atomicpacksx_claims WHERE contract = $1 AND claim_id = $2',
            [PACKS_CONTRACT, '900002'],
        );
        expect(claim.rows[0].state).to.equal(ClaimState.RESOLVED.valueOf());
        expect(Number(claim.rows[0].resolved_at_block)).to.equal(block2.block_num);

        const assets = await client.query(
            'SELECT "index", asset_id FROM atomicpacksx_claim_assets ' +
            'WHERE contract = $1 AND claim_id = $2 ORDER BY "index"',
            [PACKS_CONTRACT, '900002'],
        );
        expect(assets.rowCount).to.equal(3);
        // 1-based indices match the rest of the schema.
        expect(assets.rows.map((r: any) => r.index)).to.deep.equal([1, 2, 3]);
        expect(assets.rows.map((r: any) => r.asset_id)).to.deep.equal(['2001', '2002', '2003']);
    });

    it('cancelclaim transitions the claim to CANCELLED', async () => {
        await seedPack(client, '7003');

        const block1 = createBlock();
        const tx1 = createTx();
        await processActionTrace(processor, db, block1, tx1, createActionTrace<LogClaimActionData>(
            PACKS_CONTRACT, 'logclaim',
            { claim_id: '900003', pack_id: '7003', opener: 'opener333333', pack_asset_id: '1099999000003' },
        ));

        const block2 = createBlock({ block_num: block1.block_num + 1 });
        await processActionTrace(processor, db, block2, createTx(), createActionTrace<CancelClaimActionData>(
            PACKS_CONTRACT, 'cancelclaim', { claim_id: '900003' },
        ));

        const res = await client.query(
            'SELECT state FROM atomicpacksx_claims WHERE contract = $1 AND claim_id = $2',
            [PACKS_CONTRACT, '900003'],
        );
        expect(res.rows[0].state).to.equal(ClaimState.CANCELLED.valueOf());
    });

    it('atomicpacksx_packs_master.use_count is derived from claims', async () => {
        await seedPack(client, '7004');

        // Two claims, one resolved.
        await processActionTrace(processor, db, createBlock(), createTx(), createActionTrace<LogClaimActionData>(
            PACKS_CONTRACT, 'logclaim',
            { claim_id: '900004', pack_id: '7004', opener: 'opener444444', pack_asset_id: '4001' },
        ));
        await processActionTrace(processor, db, createBlock(), createTx(), createActionTrace<LogClaimActionData>(
            PACKS_CONTRACT, 'logclaim',
            { claim_id: '900005', pack_id: '7004', opener: 'opener555555', pack_asset_id: '4002' },
        ));

        const res = await client.query(
            'SELECT use_count FROM atomicpacksx_packs_master WHERE contract = $1 AND pack_id = $2',
            [PACKS_CONTRACT, '7004'],
        );
        expect(Number(res.rows[0].use_count)).to.equal(2);
    });
});
