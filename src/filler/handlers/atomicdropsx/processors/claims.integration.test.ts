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
import {
    ClaimDropActionData,
    ClaimDropKeyActionData,
    ClaimDropWlActionData,
    TriggerDropActionData,
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
    // @ts-ignore - test-only construction matches atomicmarket pattern.
    loader.modules = [];
    // @ts-ignore
    loader.names = [];
    return loader;
}

async function seedDrop(client: Client, dropId: string, listingPrice = '5000000000'): Promise<void> {
    await client.query(
        `INSERT INTO atomicdropsx_drops (
            contract, drop_id, assets_contract, collection_name, assets_to_mint,
            listing_price, listing_symbol, price_recipient,
            auth_required, account_limit, account_limit_cooldown, max_claimable,
            is_deleted,
            created_at_block, created_at_time, updated_at_block, updated_at_time
        ) VALUES ($1, $2, $3, 'testcol11111', '[]'::jsonb,
                  $4, 'WAX', 'collectionx1', false, 0, 0, 0, false,
                  100, 1000, 100, 1000)`,
        [DROPS_CONTRACT, dropId, ASSETS_CONTRACT, listingPrice],
    );
}

describe('atomicdropsx claimsProcessor (WAX ABI)', () => {
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

    it('claimdrop inserts a paid claim with total_price = listing_price × claim_amount (WAX field name)', async () => {
        // 5.00000000 WAX listing × 3 claims = 15.00000000 WAX → 1500000000 raw.
        await seedDrop(client, '8001', '500000000');

        const data: ClaimDropActionData = {
            claimer: 'claimer11111',
            drop_id: '8001',
            claim_amount: 3,
        };
        await processActionTrace(processor, db, createBlock(), createTx(),
            createActionTrace(DROPS_CONTRACT, 'claimdrop', data));

        const res = await client.query(
            'SELECT claimer, amount, total_price, price_symbol, is_whitelist ' +
            'FROM atomicdropsx_claims WHERE contract = $1',
            [DROPS_CONTRACT],
        );
        expect(res.rowCount).to.equal(1);
        const row = res.rows[0];
        expect(row.claimer).to.equal('claimer11111');
        expect(Number(row.amount)).to.equal(3);
        expect(row.total_price).to.equal('1500000000');
        expect(row.price_symbol).to.equal('WAX');
        expect(row.is_whitelist).to.equal(false);
    });

    it('claimdropwl records a whitelist claim (is_whitelist=true) on WAX', async () => {
        await seedDrop(client, '8002');

        const data: ClaimDropWlActionData = {
            claimer: 'claimer22222',
            drop_id: '8002',
            claim_amount: 1,
        };
        await processActionTrace(processor, db, createBlock(), createTx(),
            createActionTrace(DROPS_CONTRACT, 'claimdropwl', data));

        const res = await client.query(
            'SELECT is_whitelist FROM atomicdropsx_claims WHERE contract = $1 AND drop_id = $2',
            [DROPS_CONTRACT, '8002'],
        );
        expect(res.rowCount).to.equal(1);
        expect(res.rows[0].is_whitelist).to.equal(true);
    });

    it('claimdropkey (key-auth whitelist) records is_whitelist=true', async () => {
        await seedDrop(client, '8003');

        const data: ClaimDropKeyActionData = {
            claimer: 'claimer33333',
            drop_id: '8003',
            claim_amount: 2,
        };
        await processActionTrace(processor, db, createBlock(), createTx(),
            createActionTrace(DROPS_CONTRACT, 'claimdropkey', data));

        const res = await client.query(
            'SELECT amount, is_whitelist FROM atomicdropsx_claims WHERE contract = $1 AND drop_id = $2',
            [DROPS_CONTRACT, '8003'],
        );
        expect(res.rowCount).to.equal(1);
        expect(Number(res.rows[0].amount)).to.equal(2);
        expect(res.rows[0].is_whitelist).to.equal(true);
    });

    it('triggerdrop (admin-mediated) records claim with recipient as claimer + amount field (not claim_amount)', async () => {
        await seedDrop(client, '8004', '1000000');

        const data: TriggerDropActionData = {
            authorized_account: 'service11111',
            drop_id: '8004',
            recipient: 'enduser11111',
            amount: 5,
            trigger_provider: 'cardpayments',
            trigger_identifier: 'tx_abc123',
        };
        await processActionTrace(processor, db, createBlock(), createTx(),
            createActionTrace(DROPS_CONTRACT, 'triggerdrop', data));

        const res = await client.query(
            'SELECT claimer, amount, total_price, is_whitelist ' +
            'FROM atomicdropsx_claims WHERE contract = $1 AND drop_id = $2',
            [DROPS_CONTRACT, '8004'],
        );
        expect(res.rowCount).to.equal(1);
        expect(res.rows[0].claimer).to.equal('enduser11111');  // recipient → claimer
        expect(Number(res.rows[0].amount)).to.equal(5);
        expect(res.rows[0].total_price).to.equal('5000000');    // 1000000 × 5
        expect(res.rows[0].is_whitelist).to.equal(false);       // not a whitelist claim
    });

    it('atomicdropsx_drops_master.current_claimed is computed from SUM(amount) over claims', async () => {
        await seedDrop(client, '8005');

        // Mix of claim types - all count toward current_claimed.
        await processActionTrace(processor, db, createBlock(), createTx(), createActionTrace<ClaimDropActionData>(
            DROPS_CONTRACT, 'claimdrop', { claimer: 'a111', drop_id: '8005', claim_amount: 2 },
        ));
        await processActionTrace(processor, db, createBlock(), createTx(), createActionTrace<ClaimDropWlActionData>(
            DROPS_CONTRACT, 'claimdropwl', { claimer: 'b222', drop_id: '8005', claim_amount: 3 },
        ));

        const res = await client.query(
            'SELECT current_claimed FROM atomicdropsx_drops_master WHERE contract = $1 AND drop_id = $2',
            [DROPS_CONTRACT, '8005'],
        );
        expect(Number(res.rows[0].current_claimed)).to.equal(5);
    });
});
