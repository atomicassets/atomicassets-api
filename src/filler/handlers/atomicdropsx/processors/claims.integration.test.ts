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
    ClaimWhitelistActionData,
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

describe('atomicdropsx claimsProcessor', () => {
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

    it('claimdrop inserts a paid claim with total_price = listing_price × amount', async () => {
        // 5.00000000 WAX listing × 3 claims = 15.00000000 WAX → 1500000000 raw.
        await seedDrop(client, '8001', '500000000');

        const block = createBlock();
        const tx = createTx();
        const data: ClaimDropActionData = {
            claimer: 'claimer11111',
            drop_id: '8001',
            amount: 3,
        };
        await processActionTrace(processor, db, block, tx, createActionTrace(DROPS_CONTRACT, 'claimdrop', data));

        const res = await client.query(
            'SELECT claim_id, claimer, amount, total_price, price_symbol, is_whitelist ' +
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

    it('claimwlnft records a whitelist claim (is_whitelist=true)', async () => {
        await seedDrop(client, '8002');

        const data: ClaimWhitelistActionData = {
            claimer: 'claimer22222',
            drop_id: '8002',
            amount: 1,
        };
        await processActionTrace(processor, db, createBlock(), createTx(),
            createActionTrace(DROPS_CONTRACT, 'claimwlnft', data));

        const res = await client.query(
            'SELECT is_whitelist FROM atomicdropsx_claims WHERE contract = $1 AND drop_id = $2',
            [DROPS_CONTRACT, '8002'],
        );
        expect(res.rowCount).to.equal(1);
        expect(res.rows[0].is_whitelist).to.equal(true);
    });

    it('atomicdropsx_drops_master.current_claimed is computed from SUM(amount) over claims', async () => {
        await seedDrop(client, '8003');

        // Two claims totaling 5.
        await processActionTrace(processor, db, createBlock(), createTx(), createActionTrace<ClaimDropActionData>(
            DROPS_CONTRACT, 'claimdrop', { claimer: 'a111', drop_id: '8003', amount: 2 },
        ));
        await processActionTrace(processor, db, createBlock(), createTx(), createActionTrace<ClaimDropActionData>(
            DROPS_CONTRACT, 'claimdrop', { claimer: 'b222', drop_id: '8003', amount: 3 },
        ));

        const res = await client.query(
            'SELECT current_claimed FROM atomicdropsx_drops_master WHERE contract = $1 AND drop_id = $2',
            [DROPS_CONTRACT, '8003'],
        );
        expect(Number(res.rows[0].current_claimed)).to.equal(5);
    });

    it('legacy claimwhitelis variant is recognized for older contract deployments', async () => {
        await seedDrop(client, '8004');

        await processActionTrace(processor, db, createBlock(), createTx(),
            createActionTrace<ClaimWhitelistActionData>(
                DROPS_CONTRACT, 'claimwhitelis',
                { claimer: 'legacy11111', drop_id: '8004', amount: 1 },
            ));

        const res = await client.query(
            'SELECT is_whitelist FROM atomicdropsx_claims WHERE contract = $1 AND drop_id = $2',
            [DROPS_CONTRACT, '8004'],
        );
        expect(res.rowCount).to.equal(1);
        expect(res.rows[0].is_whitelist).to.equal(true);
    });
});
