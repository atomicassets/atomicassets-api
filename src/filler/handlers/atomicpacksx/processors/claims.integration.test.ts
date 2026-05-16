import 'mocha';
import { expect } from 'chai';
import { Client } from 'pg';

import {
    createProcessorTestContext,
    createBlock,
    createTx,
    createActionTrace,
    createContractRow,
    processActionTrace,
    processContractRow,
    createTestTransaction,
} from '../../test-helper';
import { ModuleLoader } from '../../../modules';
import DataProcessor, { ProcessingState } from '../../../processor';
import { ContractDBTransaction } from '../../../database';

import { claimsProcessor } from './claims';
import { ClaimState } from '../index';
import { LogResultActionData, ClaimUnboxedActionData } from '../types/actions';
import { UnboxPacksTableRow } from '../types/tables';

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

function unboxRow(overrides: Partial<UnboxPacksTableRow> = {}): UnboxPacksTableRow {
    return {
        pack_asset_id: '1099999000001',
        pack_id: '7001',
        unboxer: 'opener111111',
        ...overrides,
    };
}

describe('atomicpacksx claimsProcessor (1.6.0 — onContractRow + logresult + claimunboxed)', () => {
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

    it('unboxpacks row INSERT creates a CLAIMED claim with opener=unboxer (the open event)', async () => {
        await seedPack(client, '7001');
        const block = createBlock({ timestamp: '2026-05-15T00:00:00.000' });
        await processContractRow(processor, db, block, createContractRow(
            PACKS_CONTRACT, 'unboxpacks', unboxRow({ pack_asset_id: '1099999000001' }),
        ));

        const res = await client.query(
            'SELECT * FROM atomicpacksx_claims WHERE contract = $1 AND pack_asset_id = $2',
            [PACKS_CONTRACT, '1099999000001'],
        );
        expect(res.rowCount).to.equal(1);
        const row = res.rows[0];
        expect(row.claim_id).to.equal('1099999000001');
        expect(row.pack_id).to.equal('7001');
        expect(row.opener).to.equal('opener111111');
        expect(row.state).to.equal(ClaimState.CLAIMED.valueOf());
        expect(row.resolved_at_block).to.be.null;
    });

    it('unboxpacks delta DELETE is a no-op (state transition handled by claimunboxed action)', async () => {
        await seedPack(client, '7002');
        const block1 = createBlock();
        await processContractRow(processor, db, block1, createContractRow(
            PACKS_CONTRACT, 'unboxpacks', unboxRow({ pack_asset_id: '1099999000002', pack_id: '7002' }),
        ));

        const block2 = createBlock({ block_num: block1.block_num + 1 });
        await processContractRow(processor, db, block2, createContractRow(
            PACKS_CONTRACT, 'unboxpacks', unboxRow({ pack_asset_id: '1099999000002', pack_id: '7002' }), false,
        ));

        // Row should still be present with CLAIMED state (deletion ignored).
        const res = await client.query(
            'SELECT state FROM atomicpacksx_claims WHERE contract = $1 AND pack_asset_id = $2',
            [PACKS_CONTRACT, '1099999000002'],
        );
        expect(res.rowCount).to.equal(1);
        expect(res.rows[0].state).to.equal(ClaimState.CLAIMED.valueOf());
    });

    it('logresult after unboxpacks transitions CLAIMED → RESOLVED + writes template_ids', async () => {
        await seedPack(client, '7003');

        // 1. unboxpacks row delta: claim row inserted with CLAIMED.
        const block1 = createBlock();
        await processContractRow(processor, db, block1, createContractRow(
            PACKS_CONTRACT, 'unboxpacks', unboxRow({ pack_asset_id: '1099999000003', pack_id: '7003', unboxer: 'opener222222' }),
        ));

        // 2. logresult action: state → RESOLVED + claim_assets populated.
        const block2 = createBlock({ block_num: block1.block_num + 1 });
        const data: LogResultActionData = {
            pack_asset_id: '1099999000003',
            pack_id: '7003',
            template_ids: ['501', '502', '503'],
        };
        await processActionTrace(processor, db, block2, createTx(), createActionTrace(PACKS_CONTRACT, 'logresult', data));

        const claim = await client.query(
            'SELECT state, pack_id, opener, resolved_at_block FROM atomicpacksx_claims WHERE contract = $1 AND pack_asset_id = $2',
            [PACKS_CONTRACT, '1099999000003'],
        );
        expect(claim.rows[0].state).to.equal(ClaimState.RESOLVED.valueOf());
        expect(claim.rows[0].pack_id).to.equal('7003');
        expect(claim.rows[0].opener).to.equal('opener222222');  // preserved from unboxpacks insert
        expect(Number(claim.rows[0].resolved_at_block)).to.equal(block2.block_num);

        const assets = await client.query(
            'SELECT "index", template_id, asset_id FROM atomicpacksx_claim_assets ' +
            'WHERE contract = $1 AND claim_id = $2 ORDER BY "index"',
            [PACKS_CONTRACT, '1099999000003'],
        );
        expect(assets.rowCount).to.equal(3);
        expect(assets.rows.map((r: any) => r.index)).to.deep.equal([1, 2, 3]);
        expect(assets.rows.map((r: any) => r.template_id)).to.deep.equal(['501', '502', '503']);
        expect(assets.rows.every((r: any) => r.asset_id === null)).to.equal(true);
    });

    it('logresult WITHOUT prior unboxpacks (orphan resolution) inserts a fallback claim with opener=""', async () => {
        await seedPack(client, '7004');
        const block = createBlock();
        const data: LogResultActionData = {
            pack_asset_id: '1099999000004',
            pack_id: '7004',
            template_ids: ['601'],
        };
        await processActionTrace(processor, db, block, createTx(), createActionTrace(PACKS_CONTRACT, 'logresult', data));

        const claim = await client.query(
            'SELECT state, pack_id, opener FROM atomicpacksx_claims WHERE contract = $1 AND pack_asset_id = $2',
            [PACKS_CONTRACT, '1099999000004'],
        );
        expect(claim.rows[0].state).to.equal(ClaimState.RESOLVED.valueOf());
        expect(claim.rows[0].pack_id).to.equal('7004');
        expect(claim.rows[0].opener).to.equal('');   // orphan marker

        const assets = await client.query(
            'SELECT count(*) AS n FROM atomicpacksx_claim_assets WHERE contract = $1 AND claim_id = $2',
            [PACKS_CONTRACT, '1099999000004'],
        );
        expect(Number(assets.rows[0].n)).to.equal(1);   // claim_assets still populated
    });

    it('claimunboxed transitions RESOLVED → PICKED_UP', async () => {
        await seedPack(client, '7005');

        await processContractRow(processor, db, createBlock(), createContractRow(
            PACKS_CONTRACT, 'unboxpacks', unboxRow({ pack_asset_id: '1099999000005', pack_id: '7005' }),
        ));
        await processActionTrace(processor, db, createBlock(), createTx(), createActionTrace<LogResultActionData>(
            PACKS_CONTRACT, 'logresult',
            { pack_asset_id: '1099999000005', pack_id: '7005', template_ids: ['701'] },
        ));

        const data: ClaimUnboxedActionData = {
            pack_asset_id: '1099999000005',
            origin_roll_ids: ['0'],
        };
        await processActionTrace(processor, db, createBlock(), createTx(), createActionTrace(
            PACKS_CONTRACT, 'claimunboxed', data,
            { act: { account: PACKS_CONTRACT, name: 'claimunboxed', authorization: [{ actor: 'opener111111', permission: 'active' }], data } },
        ));

        const res = await client.query(
            'SELECT state FROM atomicpacksx_claims WHERE contract = $1 AND pack_asset_id = $2',
            [PACKS_CONTRACT, '1099999000005'],
        );
        expect(res.rows[0].state).to.equal(ClaimState.PICKED_UP.valueOf());
    });

    it('claimunboxed BEFORE logresult does not downgrade state (no clobber on early/out-of-order pickup)', async () => {
        await seedPack(client, '7006');

        await processContractRow(processor, db, createBlock(), createContractRow(
            PACKS_CONTRACT, 'unboxpacks', unboxRow({ pack_asset_id: '1099999000006', pack_id: '7006' }),
        ));

        // Hypothetical out-of-order delivery: claimunboxed arrives before logresult.
        // The state guard (state >= RESOLVED) makes this a no-op.
        const data: ClaimUnboxedActionData = { pack_asset_id: '1099999000006', origin_roll_ids: ['0'] };
        await processActionTrace(processor, db, createBlock(), createTx(), createActionTrace(
            PACKS_CONTRACT, 'claimunboxed', data,
            { act: { account: PACKS_CONTRACT, name: 'claimunboxed', authorization: [{ actor: 'opener111111', permission: 'active' }], data } },
        ));

        const res = await client.query(
            'SELECT state FROM atomicpacksx_claims WHERE contract = $1 AND pack_asset_id = $2',
            [PACKS_CONTRACT, '1099999000006'],
        );
        // Stays CLAIMED — guard prevented the PICKED_UP downgrade-from-CLAIMED.
        expect(res.rows[0].state).to.equal(ClaimState.CLAIMED.valueOf());
    });

    it('atomicpacksx_packs_master.use_count derives correctly across multiple opens of the same pack', async () => {
        await seedPack(client, '7007');

        for (const packAssetId of ['1099999000010', '1099999000011']) {
            await processContractRow(processor, db, createBlock(), createContractRow(
                PACKS_CONTRACT, 'unboxpacks', unboxRow({ pack_asset_id: packAssetId, pack_id: '7007', unboxer: 'opener333333' }),
            ));
            await processActionTrace(processor, db, createBlock(), createTx(), createActionTrace<LogResultActionData>(
                PACKS_CONTRACT, 'logresult',
                { pack_asset_id: packAssetId, pack_id: '7007', template_ids: ['501'] },
            ));
        }

        const res = await client.query(
            'SELECT use_count FROM atomicpacksx_packs_master WHERE contract = $1 AND pack_id = $2',
            [PACKS_CONTRACT, '7007'],
        );
        expect(Number(res.rows[0].use_count)).to.equal(2);
    });
});
