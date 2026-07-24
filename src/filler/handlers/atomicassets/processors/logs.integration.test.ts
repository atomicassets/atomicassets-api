import 'mocha';
import { expect } from 'chai';
import { Client } from 'pg';
import { serialize, ObjectSchema } from 'atomicassets';
import {
    createProcessorTestContext,
    createBlock,
    createTx,
    createActionTrace,
    createContractRow,
    createTestTransaction,
} from '../../test-helper';
import { collectionProcessor } from './collections';
import { logProcessor } from './logs';
import DataProcessor, { ProcessingState } from '../../../processor';
import { ContractDBTransaction } from '../../../database';
import { CollectionsTableRow, AuthorSwapsTableRow } from '../types/tables';
import {
    CreateAuthorSwapActionData,
    AcceptAuthorSwapActionData,
    RejectAuthorSwapActionData,
} from '../types/actions';
import { EosioActionTrace } from '../../../../types/eosio';
import { ModuleLoader } from '../../../modules';

const CONTRACT = 'atomicassets';

const COLLECTION_FORMAT = [
    { name: 'name', type: 'string' },
    { name: 'img', type: 'string' },
];

function createMockCore(overrides: Record<string, any> = {}): any {
    return {
        args: {
            atomicassets_account: CONTRACT,
            store_transfers: true,
            store_logs: true,
            ...overrides,
        },
        config: {
            collection_format: COLLECTION_FORMAT,
            supported_tokens: [],
            asset_counter: 0,
            offer_counter: 0,
        },
    };
}

function createMockModuleLoader(): ModuleLoader {
    const loader = Object.create(ModuleLoader.prototype) as ModuleLoader;
    // @ts-ignore
    loader.modules = [];
    // @ts-ignore
    loader.names = [];
    return loader;
}

function serializeCollectionData(data: Record<string, string>): string {
    const schema = ObjectSchema(COLLECTION_FORMAT);
    return Buffer.from(serialize(data, schema)).toString('hex');
}

function createCollectionsDelta(collectionName: string, author: string): any {
    const deltaValue: CollectionsTableRow = {
        collection_name: collectionName,
        author,
        allow_notify: 1,
        authorized_accounts: [author],
        notify_accounts: [],
        market_fee: 0.05,
        serialized_data: serializeCollectionData({ name: 'Swap Test', img: 'QmSwap' }) as any,
    };
    return createContractRow(CONTRACT, 'collections', deltaValue, true);
}

function createAuthorSwapsDelta(
    collectionName: string, currentAuthor: string, newAuthor: string,
    acceptanceDate: number, present: boolean,
): any {
    const value: AuthorSwapsTableRow = {
        collection_name: collectionName,
        current_author: currentAuthor,
        new_author: newAuthor,
        acceptance_date: acceptanceDate,
    };
    return createContractRow(CONTRACT, 'authorswaps', value, present);
}

function createAuswapTrace<T>(name: string, data: T, actor: string | null): EosioActionTrace<T> {
    const trace = createActionTrace(CONTRACT, name, data);
    if (actor) {
        trace.act.authorization = [{ actor, permission: 'active' }];
    }
    return trace;
}

/**
 * Persist buffered action logs the way ContractDBTransaction.commit() does,
 * without committing the harness transaction (the test rolls back).
 */
async function flushActionLogs(db: ContractDBTransaction): Promise<void> {
    if (db.actionLogs.length > 0) {
        await db.insert('contract_traces', db.actionLogs, ['global_sequence', 'account']);
        db.actionLogs = [];
    }
}

describe('logProcessor auswap metadata', () => {
    let client: Client;
    let processor: DataProcessor;
    let db: ContractDBTransaction;
    let destructors: Array<() => any>;

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
        const core = createMockCore();
        // Register both processors like AtomicAssetsHandler.register() does:
        // the collections processor applies the table deltas, the log
        // processor writes the traces - the auswap metadata depends on the
        // relative order the DataProcessor queue runs them in.
        destructors = [
            collectionProcessor(core as any, processor),
            logProcessor(core as any, processor),
        ];
    });

    afterEach(async () => {
        for (const destroy of destructors) {
            destroy();
        }
        await client.query('ROLLBACK');
    });

    async function getTraceMetadata(name: string): Promise<any[]> {
        const result = await client.query(
            'SELECT metadata FROM contract_traces WHERE account = $1 AND name = $2 ORDER BY global_sequence',
            [CONTRACT, name]
        );
        return result.rows.map(row => row.metadata);
    }

    /** Seed a collection through the real collections-delta path in its own commit batch. */
    async function seedCollection(collectionName: string, author: string): Promise<void> {
        processor.processContractRow(createBlock(), createCollectionsDelta(collectionName, author));
        await processor.executeHeadQueue(db);
    }

    /** Seed a pending author swap (createauswap + its delta) in its own commit batch. */
    async function seedPendingSwap(
        collectionName: string, currentAuthor: string, newAuthor: string, acceptanceDate: number,
    ): Promise<void> {
        const block = createBlock();
        const data: CreateAuthorSwapActionData = {
            collection_name: collectionName, new_author: newAuthor, owner: false,
        };
        processor.processActionTrace(block, createTx(), createAuswapTrace('createauswap', data, currentAuthor));
        processor.processContractRow(block, createAuthorSwapsDelta(collectionName, currentAuthor, newAuthor, acceptanceDate, true));
        await processor.executeHeadQueue(db);
        await flushActionLogs(db);
    }

    describe('createauswap', () => {
        it('stores acceptance_date from the authorswaps delta of the same block', async () => {
            await seedCollection('swapcol11111', 'authoralice1');

            const block = createBlock();
            const data: CreateAuthorSwapActionData = {
                collection_name: 'swapcol11111', new_author: 'authorbob111', owner: false,
            };
            processor.processActionTrace(block, createTx(), createAuswapTrace('createauswap', data, 'authoralice1'));
            processor.processContractRow(block, createAuthorSwapsDelta('swapcol11111', 'authoralice1', 'authorbob111', 1700000000, true));
            await processor.executeHeadQueue(db);
            await flushActionLogs(db);

            const metadata = await getTraceMetadata('createauswap');
            expect(metadata).to.have.length(1);
            expect(metadata[0]).to.deep.equal({
                collection_name: 'swapcol11111',
                new_author: 'authorbob111',
                owner: false,
                acceptance_date: 1700000000,
            });

            // The delta also ran: the pending swap reached the collections row.
            const col = await client.query(
                'SELECT new_author_name FROM atomicassets_collections WHERE contract = $1 AND collection_name = $2',
                [CONTRACT, 'swapcol11111']
            );
            expect(col.rows[0].new_author_name).to.equal('authorbob111');
        });

        it('omits acceptance_date when no authorswaps delta arrives in the batch', async () => {
            await seedCollection('swapcol11112', 'authoralice1');

            const data: CreateAuthorSwapActionData = {
                collection_name: 'swapcol11112', new_author: 'authorbob111', owner: true,
            };
            processor.processActionTrace(createBlock(), createTx(), createAuswapTrace('createauswap', data, 'authoralice1'));
            await processor.executeHeadQueue(db);
            await flushActionLogs(db);

            const metadata = await getTraceMetadata('createauswap');
            expect(metadata).to.have.length(1);
            expect(metadata[0]).to.deep.equal({
                collection_name: 'swapcol11112',
                new_author: 'authorbob111',
                owner: true,
            });
        });
    });

    describe('acceptauswap', () => {
        it('resolves prior_author and new_author when the action shares a block with its deltas', async () => {
            await seedCollection('swapcol11113', 'authoralice1');
            await seedPendingSwap('swapcol11113', 'authoralice1', 'authorbob111', 1700000000);

            // The accept, the collections author flip, and the authorswaps
            // row removal all land in the same block and the same commit
            // batch - the log handler must still see the pre-swap state.
            const block = createBlock();
            const data: AcceptAuthorSwapActionData = { collection_name: 'swapcol11113' };
            processor.processActionTrace(block, createTx(), createAuswapTrace('acceptauswap', data, 'authorbob111'));
            processor.processContractRow(block, createCollectionsDelta('swapcol11113', 'authorbob111'));
            processor.processContractRow(block, createAuthorSwapsDelta('swapcol11113', 'authoralice1', 'authorbob111', 1700000000, false));
            await processor.executeHeadQueue(db);
            await flushActionLogs(db);

            const metadata = await getTraceMetadata('acceptauswap');
            expect(metadata).to.have.length(1);
            expect(metadata[0]).to.deep.equal({
                collection_name: 'swapcol11113',
                new_author: 'authorbob111',
                prior_author: 'authoralice1',
                actor: 'authorbob111',
            });

            // The deltas of that block ran after the log handler and won:
            // the collection now carries the new author and no pending swap.
            const col = await client.query(
                'SELECT author, new_author_name FROM atomicassets_collections WHERE contract = $1 AND collection_name = $2',
                [CONTRACT, 'swapcol11113']
            );
            expect(col.rows[0].author).to.equal('authorbob111');
            expect(col.rows[0].new_author_name).to.equal(null);
        });

        it('resolves the swap from the batch ledger when createauswap rides the same batch', async () => {
            await seedCollection('swapcol11114', 'authoralice1');

            // Owner-permission swaps have an immediate acceptance_date, so a
            // catch-up batch can contain the whole swap lifecycle. The
            // database never sees the pending swap before the accept log
            // runs, so new_author can only come from the batch ledger.
            const createBlockRef = createBlock();
            const acceptBlockRef = createBlock();

            const createData: CreateAuthorSwapActionData = {
                collection_name: 'swapcol11114', new_author: 'authorbob111', owner: true,
            };
            const acceptData: AcceptAuthorSwapActionData = { collection_name: 'swapcol11114' };

            processor.processActionTrace(createBlockRef, createTx(), createAuswapTrace('createauswap', createData, 'authoralice1'));
            processor.processContractRow(createBlockRef, createAuthorSwapsDelta('swapcol11114', 'authoralice1', 'authorbob111', 1700000100, true));
            processor.processActionTrace(acceptBlockRef, createTx(), createAuswapTrace('acceptauswap', acceptData, 'authorbob111'));
            processor.processContractRow(acceptBlockRef, createCollectionsDelta('swapcol11114', 'authorbob111'));
            processor.processContractRow(acceptBlockRef, createAuthorSwapsDelta('swapcol11114', 'authoralice1', 'authorbob111', 1700000100, false));

            // Nothing of the swap is visible in the database yet.
            const before = await client.query(
                'SELECT author, new_author_name FROM atomicassets_collections WHERE contract = $1 AND collection_name = $2',
                [CONTRACT, 'swapcol11114']
            );
            expect(before.rows[0].author).to.equal('authoralice1');
            expect(before.rows[0].new_author_name).to.equal(null);

            await processor.executeHeadQueue(db);
            await flushActionLogs(db);

            const createMetadata = await getTraceMetadata('createauswap');
            expect(createMetadata).to.have.length(1);
            expect(createMetadata[0]).to.deep.equal({
                collection_name: 'swapcol11114',
                new_author: 'authorbob111',
                owner: true,
                acceptance_date: 1700000100,
            });

            const acceptMetadata = await getTraceMetadata('acceptauswap');
            expect(acceptMetadata).to.have.length(1);
            expect(acceptMetadata[0]).to.deep.equal({
                collection_name: 'swapcol11114',
                new_author: 'authorbob111',
                prior_author: 'authoralice1',
                actor: 'authorbob111',
            });
        });

        it('enriches acceptance_date from the removal delta when the swap is born and erased in one block', async () => {
            await seedCollection('swapcol11117', 'authoralice1');

            // An owner-permission swap can be created and accepted within a
            // single block. The authorswaps row never survives the block, so
            // the only delta SHIP emits for it is the removal - which still
            // carries the row value, acceptance_date included. The deferred
            // createauswap entry must enrich from that removal instead of
            // falling back to the commit flush without the field.
            const block = createBlock();

            processor.processActionTrace(block, createTx(), createAuswapTrace('createauswap', {
                collection_name: 'swapcol11117', new_author: 'authorbob111', owner: true,
            } as CreateAuthorSwapActionData, 'authoralice1'));
            processor.processActionTrace(block, createTx(), createAuswapTrace('acceptauswap', {
                collection_name: 'swapcol11117',
            } as AcceptAuthorSwapActionData, 'authorbob111'));
            processor.processContractRow(block, createCollectionsDelta('swapcol11117', 'authorbob111'));
            processor.processContractRow(block, createAuthorSwapsDelta('swapcol11117', 'authoralice1', 'authorbob111', 1700000200, false));

            await processor.executeHeadQueue(db);
            await flushActionLogs(db);

            const createMetadata = await getTraceMetadata('createauswap');
            expect(createMetadata).to.have.length(1);
            expect(createMetadata[0]).to.deep.equal({
                collection_name: 'swapcol11117',
                new_author: 'authorbob111',
                owner: true,
                acceptance_date: 1700000200,
            });

            const acceptMetadata = await getTraceMetadata('acceptauswap');
            expect(acceptMetadata).to.have.length(1);
            expect(acceptMetadata[0]).to.deep.equal({
                collection_name: 'swapcol11117',
                new_author: 'authorbob111',
                prior_author: 'authoralice1',
                actor: 'authorbob111',
            });
        });

        it('stores only the derivable fields when the collection is unknown', async () => {
            const data: AcceptAuthorSwapActionData = { collection_name: 'ghostcol1111' };
            const trace = createAuswapTrace('acceptauswap', data, null);
            processor.processActionTrace(createBlock(), createTx(), trace);
            await processor.executeHeadQueue(db);
            await flushActionLogs(db);

            const metadata = await getTraceMetadata('acceptauswap');
            expect(metadata).to.have.length(1);
            expect(metadata[0]).to.deep.equal({ collection_name: 'ghostcol1111' });
        });
    });

    describe('rejectauswap', () => {
        it('resolves prior_author and new_author when the action shares a block with the removal delta', async () => {
            await seedCollection('swapcol11115', 'authoralice1');
            await seedPendingSwap('swapcol11115', 'authoralice1', 'authorbob111', 1700000000);

            const block = createBlock();
            const data: RejectAuthorSwapActionData = { collection_name: 'swapcol11115' };
            processor.processActionTrace(block, createTx(), createAuswapTrace('rejectauswap', data, 'authoralice1'));
            processor.processContractRow(block, createAuthorSwapsDelta('swapcol11115', 'authoralice1', 'authorbob111', 1700000000, false));
            await processor.executeHeadQueue(db);
            await flushActionLogs(db);

            const metadata = await getTraceMetadata('rejectauswap');
            expect(metadata).to.have.length(1);
            expect(metadata[0]).to.deep.equal({
                collection_name: 'swapcol11115',
                new_author: 'authorbob111',
                prior_author: 'authoralice1',
                actor: 'authoralice1',
            });

            // The author never changed and the pending swap is cleared.
            const col = await client.query(
                'SELECT author, new_author_name FROM atomicassets_collections WHERE contract = $1 AND collection_name = $2',
                [CONTRACT, 'swapcol11115']
            );
            expect(col.rows[0].author).to.equal('authoralice1');
            expect(col.rows[0].new_author_name).to.equal(null);
        });

        it('supports a reject and a replacement swap for the same collection in one batch', async () => {
            await seedCollection('swapcol11116', 'authoralice1');
            await seedPendingSwap('swapcol11116', 'authoralice1', 'authorbob111', 1700000000);

            // reject swap 1, then create swap 2 for another proposed author,
            // all in one commit batch. The reject must report swap 1 (from
            // the database pre-state, since its log runs before the create's
            // ledger entry could confuse it) and the create must pick up its
            // own delta's acceptance_date.
            const rejectBlock = createBlock();
            const createBlock2 = createBlock();

            processor.processActionTrace(
                rejectBlock, createTx(),
                createAuswapTrace('rejectauswap', { collection_name: 'swapcol11116' } as RejectAuthorSwapActionData, 'authorbob111')
            );
            processor.processContractRow(rejectBlock, createAuthorSwapsDelta('swapcol11116', 'authoralice1', 'authorbob111', 1700000000, false));

            processor.processActionTrace(
                createBlock2, createTx(),
                createAuswapTrace('createauswap', {
                    collection_name: 'swapcol11116', new_author: 'authorcarol1', owner: false,
                } as CreateAuthorSwapActionData, 'authoralice1')
            );
            processor.processContractRow(createBlock2, createAuthorSwapsDelta('swapcol11116', 'authoralice1', 'authorcarol1', 1700604800, true));

            await processor.executeHeadQueue(db);
            await flushActionLogs(db);

            const rejectMetadata = await getTraceMetadata('rejectauswap');
            expect(rejectMetadata).to.have.length(1);
            expect(rejectMetadata[0]).to.deep.equal({
                collection_name: 'swapcol11116',
                new_author: 'authorbob111',
                prior_author: 'authoralice1',
                actor: 'authorbob111',
            });

            const createMetadata = await getTraceMetadata('createauswap');
            expect(createMetadata).to.have.length(2);
            expect(createMetadata[1]).to.deep.equal({
                collection_name: 'swapcol11116',
                new_author: 'authorcarol1',
                owner: false,
                acceptance_date: 1700604800,
            });
        });
    });
});
