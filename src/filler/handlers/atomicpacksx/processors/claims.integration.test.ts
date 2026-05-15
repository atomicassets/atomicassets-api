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
    ClaimUnboxedActionData,
    LogResultActionData,
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

describe('atomicpacksx claimsProcessor (WAX ABI: claimunboxed + logresult)', () => {
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

    it('claimunboxed inserts a CLAIMED row with claim_id = pack_asset_id and opener from authorization', async () => {
        const block = createBlock({ timestamp: '2026-05-15T00:00:00.000' });
        const tx = createTx();
        const data: ClaimUnboxedActionData = {
            pack_asset_id: '1099999000001',
            origin_roll_ids: ['0'],
        };
        const trace = createActionTrace(PACKS_CONTRACT, 'claimunboxed', data, {
            act: {
                account: PACKS_CONTRACT,
                name: 'claimunboxed',
                authorization: [{ actor: 'opener111111', permission: 'active' }],
                data,
            },
        });

        await processActionTrace(processor, db, block, tx, trace);

        const res = await client.query(
            'SELECT * FROM atomicpacksx_claims WHERE contract = $1 AND pack_asset_id = $2',
            [PACKS_CONTRACT, '1099999000001'],
        );
        expect(res.rowCount).to.equal(1);
        const row = res.rows[0];
        expect(row.claim_id).to.equal('1099999000001');     // 1:1 with pack_asset_id
        expect(row.opener).to.equal('opener111111');         // from authorization
        expect(row.pack_id).to.be.null;                      // populated by logresult
        expect(row.state).to.equal(ClaimState.CLAIMED.valueOf());
        expect(row.txid).to.deep.equal(Buffer.from(tx.id, 'hex'));
        expect(row.resolved_at_block).to.be.null;
    });

    it('logresult transitions to RESOLVED + sets pack_id + writes template_ids into claim_assets', async () => {
        await seedPack(client, '7002');

        // 1. claimunboxed inserts the claim
        const block1 = createBlock();
        const data1: ClaimUnboxedActionData = { pack_asset_id: '1099999000002', origin_roll_ids: ['0'] };
        await processActionTrace(processor, db, block1, createTx(), createActionTrace(PACKS_CONTRACT, 'claimunboxed', data1, {
            act: { account: PACKS_CONTRACT, name: 'claimunboxed', authorization: [{ actor: 'opener222222', permission: 'active' }], data: data1 },
        }));

        // 2. logresult resolves it
        const block2 = createBlock({ block_num: block1.block_num + 1 });
        const data2: LogResultActionData = {
            pack_asset_id: '1099999000002',
            pack_id: '7002',
            template_ids: ['501', '502', '503'],
        };
        await processActionTrace(processor, db, block2, createTx(), createActionTrace(PACKS_CONTRACT, 'logresult', data2));

        const claim = await client.query(
            'SELECT state, pack_id, resolved_at_block FROM atomicpacksx_claims WHERE contract = $1 AND pack_asset_id = $2',
            [PACKS_CONTRACT, '1099999000002'],
        );
        expect(claim.rows[0].state).to.equal(ClaimState.RESOLVED.valueOf());
        expect(claim.rows[0].pack_id).to.equal('7002');
        expect(Number(claim.rows[0].resolved_at_block)).to.equal(block2.block_num);

        const assets = await client.query(
            'SELECT "index", template_id, asset_id FROM atomicpacksx_claim_assets ' +
            'WHERE contract = $1 AND claim_id = $2 ORDER BY "index"',
            [PACKS_CONTRACT, '1099999000002'],
        );
        expect(assets.rowCount).to.equal(3);
        expect(assets.rows.map((r: any) => r.index)).to.deep.equal([1, 2, 3]);
        expect(assets.rows.map((r: any) => r.template_id)).to.deep.equal(['501', '502', '503']);
        // asset_id stays NULL until atomicassets logmint backfills it
        expect(assets.rows.every((r: any) => r.asset_id === null)).to.equal(true);
    });

    it('logresult creates a placeholder claim row when claimunboxed was missed (orphan recovery)', async () => {
        // Simulates: user opened a pack BEFORE this filler started indexing,
        // then logresult fires post-deploy. With no parent claim row, the
        // naive UPDATE matches 0 rows and the claim_assets INSERT FK-violates.
        // The orphan-recovery path inserts a placeholder claim row first.
        await seedPack(client, '7099');

        const block = createBlock();
        const data: LogResultActionData = {
            pack_asset_id: '1099987900151',
            pack_id: '7099',
            template_ids: ['910', '911'],
        };
        await processActionTrace(processor, db, block, createTx(), createActionTrace(PACKS_CONTRACT, 'logresult', data));

        const claim = await client.query(
            'SELECT state, pack_id, opener, claimed_at_block, resolved_at_block ' +
            'FROM atomicpacksx_claims WHERE contract = $1 AND pack_asset_id = $2',
            [PACKS_CONTRACT, '1099987900151'],
        );
        expect(claim.rowCount).to.equal(1);
        expect(claim.rows[0].state).to.equal(ClaimState.RESOLVED.valueOf());
        expect(claim.rows[0].pack_id).to.equal('7099');
        expect(claim.rows[0].opener).to.equal('');                              // unknown without claimunboxed
        expect(Number(claim.rows[0].claimed_at_block)).to.equal(block.block_num); // best-effort = resolved
        expect(Number(claim.rows[0].resolved_at_block)).to.equal(block.block_num);

        const assets = await client.query(
            'SELECT template_id FROM atomicpacksx_claim_assets ' +
            'WHERE contract = $1 AND claim_id = $2 ORDER BY "index"',
            [PACKS_CONTRACT, '1099987900151'],
        );
        expect(assets.rowCount).to.equal(2);
        expect(assets.rows.map((r: any) => r.template_id)).to.deep.equal(['910', '911']);
    });

    it('logresult preserves opener + claimed_at from a prior claimunboxed (no clobber)', async () => {
        await seedPack(client, '7100');

        // 1. claimunboxed records the real opener + claimed_at
        const block1 = createBlock();
        const claimData: ClaimUnboxedActionData = { pack_asset_id: '1099987900200', origin_roll_ids: ['0'] };
        await processActionTrace(processor, db, block1, createTx(), createActionTrace(PACKS_CONTRACT, 'claimunboxed', claimData, {
            act: { account: PACKS_CONTRACT, name: 'claimunboxed', authorization: [{ actor: 'realopener11', permission: 'active' }], data: claimData },
        }));

        // 2. logresult fires later — the placeholder INSERT should NOT
        // overwrite the existing opener / claimed_at_block.
        const block2 = createBlock({ block_num: block1.block_num + 100 });
        const resultData: LogResultActionData = { pack_asset_id: '1099987900200', pack_id: '7100', template_ids: ['920'] };
        await processActionTrace(processor, db, block2, createTx(), createActionTrace(PACKS_CONTRACT, 'logresult', resultData));

        const res = await client.query(
            'SELECT opener, claimed_at_block, resolved_at_block, state ' +
            'FROM atomicpacksx_claims WHERE contract = $1 AND pack_asset_id = $2',
            [PACKS_CONTRACT, '1099987900200'],
        );
        expect(res.rowCount).to.equal(1);
        expect(res.rows[0].opener).to.equal('realopener11');                     // preserved
        expect(Number(res.rows[0].claimed_at_block)).to.equal(block1.block_num);  // preserved
        expect(Number(res.rows[0].resolved_at_block)).to.equal(block2.block_num); // updated
        expect(res.rows[0].state).to.equal(ClaimState.RESOLVED.valueOf());
    });

    it('atomicpacksx_packs_master.use_count is derived from claims (counts CLAIMED + RESOLVED)', async () => {
        await seedPack(client, '7003');

        // Two claimunboxed actions for the same pack — but we don't know
        // pack_id at claimunboxed time. logresult fills it.
        await processActionTrace(processor, db, createBlock(), createTx(), createActionTrace<ClaimUnboxedActionData>(
            PACKS_CONTRACT, 'claimunboxed',
            { pack_asset_id: '1099999000003', origin_roll_ids: ['0'] },
            { act: { account: PACKS_CONTRACT, name: 'claimunboxed', authorization: [{ actor: 'opener333333', permission: 'active' }], data: { pack_asset_id: '1099999000003', origin_roll_ids: ['0'] } } },
        ));
        await processActionTrace(processor, db, createBlock(), createTx(), createActionTrace<LogResultActionData>(
            PACKS_CONTRACT, 'logresult',
            { pack_asset_id: '1099999000003', pack_id: '7003', template_ids: ['501'] },
        ));

        await processActionTrace(processor, db, createBlock(), createTx(), createActionTrace<ClaimUnboxedActionData>(
            PACKS_CONTRACT, 'claimunboxed',
            { pack_asset_id: '1099999000004', origin_roll_ids: ['0'] },
            { act: { account: PACKS_CONTRACT, name: 'claimunboxed', authorization: [{ actor: 'opener444444', permission: 'active' }], data: { pack_asset_id: '1099999000004', origin_roll_ids: ['0'] } } },
        ));
        await processActionTrace(processor, db, createBlock(), createTx(), createActionTrace<LogResultActionData>(
            PACKS_CONTRACT, 'logresult',
            { pack_asset_id: '1099999000004', pack_id: '7003', template_ids: ['502'] },
        ));

        const res = await client.query(
            'SELECT use_count FROM atomicpacksx_packs_master WHERE contract = $1 AND pack_id = $2',
            [PACKS_CONTRACT, '7003'],
        );
        expect(Number(res.rows[0].use_count)).to.equal(2);
    });
});
