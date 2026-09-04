/**
 * Shared test helper for filler processor integration tests.
 *
 * Provides:
 *  - A TestClient-based setup with BEGIN/ROLLBACK isolation
 *  - A real DataProcessor with a no-op ModuleLoader
 *  - A ContractDBTransaction backed by the test connection
 *  - Factory functions for mock block, transaction, and action-trace data
 */
import { Client, QueryResult } from 'pg';
import { getTestPostgresConfig } from '../../utils/test';
import DataProcessor, { ProcessingState } from '../processor';
import { ContractDBTransaction } from '../database';
import { ShipBlock } from '../../types/ship';
import { EosioActionTrace, EosioContractRow, EosioTransaction } from '../../types/eosio';
import { ModuleLoader } from '../modules';

// ---------------------------------------------------------------------------
// Mock ModuleLoader that has no modules (nothing to filter)
// ---------------------------------------------------------------------------
function createMockModuleLoader(): ModuleLoader {
    // ModuleLoader constructor tries to require() module files from disk.
    // We bypass this by creating a plain object that satisfies the interface.
    const loader = Object.create(ModuleLoader.prototype) as ModuleLoader;
    // @ts-ignore - override private field
    loader.modules = [];
    // @ts-ignore - override readonly field
    loader.names = [];
    return loader;
}

// ---------------------------------------------------------------------------
// Adapter: wrap a pg.Client as a PoolClient-like for ContractDBTransaction
// ---------------------------------------------------------------------------
export interface PoolClientLike {
    query(queryText: string, values?: any[]): Promise<QueryResult>;
    escapeIdentifier(str: string): string;
    release(): void;
}

function wrapClientAsPoolClient(client: Client): PoolClientLike {
    return {
        query: (queryText: string, values?: any[]): Promise<QueryResult> => client.query(queryText, values),
        escapeIdentifier: (str: string): string => `"${str.replace(/"/g, '""')}"`,
        release: (): void => { /* no-op for test client */ },
    };
}

// ---------------------------------------------------------------------------
// Create a ContractDBTransaction from a plain pg.Client
// ---------------------------------------------------------------------------
export function createTestTransaction(client: Client, readerName = 'test-reader', currentBlock?: number): ContractDBTransaction {
    const poolClient = wrapClientAsPoolClient(client) as any;
    const stats = { operations: 0 };
    // currentBlock defaults to undefined so no reversible-query bookkeeping is
    // attempted; pass a block number (head-mode reader) to exercise the
    // reversible_queries rollback-log path in a test.
    const txn = new ContractDBTransaction(poolClient, readerName, stats, currentBlock);
    // Mark as already in a transaction so it does not issue its own BEGIN.
    // The test harness manages BEGIN/ROLLBACK externally.
    txn.inTransaction = true;
    return txn;
}

// ---------------------------------------------------------------------------
// Processor test context
// ---------------------------------------------------------------------------
export interface ProcessorTestContext {
    /** pg.Client connected to the test database */
    client: Client;
    /** Real DataProcessor instance */
    processor: DataProcessor;
    /** Create a fresh ContractDBTransaction for a test (already inside BEGIN) */
    createTransaction(): ContractDBTransaction;
}

/**
 * Setup a full processor-test context.
 *
 * Call `ctx.client.connect()` in before(), `ctx.client.end()` in after().
 */
export function createProcessorTestContext(): ProcessorTestContext {
    const client = new Client(getTestPostgresConfig());
    const moduleLoader = createMockModuleLoader();
    const processor = new DataProcessor(ProcessingState.HEAD, moduleLoader);

    return {
        client,
        processor,
        createTransaction(): ContractDBTransaction {
            return createTestTransaction(client);
        },
    };
}

// ---------------------------------------------------------------------------
// No-op notification sender
// ---------------------------------------------------------------------------
export function createMockNotifier(): any {
    return {
        sendActionTrace: (): void => {},
        sendContractRow: (): void => {},
    };
}

export interface RecordedTrace {
    channel: string;
    trace: EosioActionTrace<any>;
}

export interface RecordingNotifier {
    notifier: any;
    /** Every action trace the processor queued, in order. */
    traces: RecordedTrace[];
}

/**
 * A notification sender that records what a processor queues instead of
 * publishing it, for a test that asserts which socket event a path announces.
 */
export function createRecordingNotifier(): RecordingNotifier {
    const traces: RecordedTrace[] = [];

    return {
        notifier: {
            sendActionTrace: (channel: string, _block: ShipBlock, _tx: EosioTransaction, trace: EosioActionTrace<any>): void => {
                traces.push({channel, trace});
            },
            sendContractRow: (): void => {},
        },
        traces,
    };
}

// ---------------------------------------------------------------------------
// Stub transaction for unit tests that must not reach a database
// ---------------------------------------------------------------------------
export interface StubQueryCall {
    sql: string;
    values: any[];
}

export interface StubWriteCall {
    table: string;
    values: any;
    condition?: any;
}

export interface StubTransaction {
    /** Pass this where a ContractDBTransaction is expected. */
    db: any;
    queries: StubQueryCall[];
    updates: StubWriteCall[];
    inserts: StubWriteCall[];
}

/**
 * A ContractDBTransaction stand-in whose reads come from `respond` and whose
 * writes are only recorded. `respond` receives each statement and its values
 * and returns the rows to answer with; returning undefined answers with none.
 */
export function createStubTransaction(respond: (sql: string, values: any[]) => any[] | undefined): StubTransaction {
    const queries: StubQueryCall[] = [];
    const updates: StubWriteCall[] = [];
    const inserts: StubWriteCall[] = [];

    const db = {
        query: async (sql: string, values: any[] = []): Promise<any> => {
            queries.push({sql, values});

            const rows = respond(sql, values) || [];

            return {rows, rowCount: rows.length};
        },
        update: async (table: string, values: any, condition: any): Promise<any> => {
            updates.push({table, values, condition});

            return {rows: [], rowCount: 1};
        },
        insert: async (table: string, values: any): Promise<any> => {
            inserts.push({table, values});

            return {rows: [], rowCount: Array.isArray(values) ? values.length : 1};
        },
    };

    return {db, queries, updates, inserts};
}

// ---------------------------------------------------------------------------
// Mock data factories
// ---------------------------------------------------------------------------
let blockCounter = 10000;

export function createBlock(overrides: Partial<ShipBlock> = {}): ShipBlock {
    const num = ++blockCounter;
    const id = num.toString(16).padStart(64, '0');
    return {
        block_num: num,
        block_id: id,
        timestamp: '2023-01-01T00:00:00.000',
        head: { block_num: num, block_id: id },
        last_irreversible: { block_num: num - 5, block_id: 'f'.repeat(64) },
        ...overrides,
    };
}

let txCounter = 0;
export function createTx(overrides: Partial<EosioTransaction> = {}): EosioTransaction {
    txCounter++;
    return {
        id: txCounter.toString(16).padStart(64, 'a'),
        cpu_usage_us: 0,
        net_usage_words: 0,
        ...overrides,
    } as EosioTransaction;
}

let seqCounter = 100;
export function createActionTrace<T>(
    account: string,
    name: string,
    data: T,
    overrides: Partial<EosioActionTrace<T>> = {},
): EosioActionTrace<T> {
    const seq = String(++seqCounter);
    return {
        action_ordinal: 1,
        creator_action_ordinal: 0,
        global_sequence: seq,
        account_ram_deltas: [],
        act: {
            account,
            name,
            authorization: [],
            data,
        },
        ...overrides,
    };
}

export function createContractRow<T>(
    code: string,
    table: string,
    value: T,
    present: boolean = true,
    overrides: Partial<EosioContractRow<T>> = {},
): EosioContractRow<T> {
    return {
        code,
        scope: code,
        table,
        primary_key: '0',
        payer: code,
        present,
        value,
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// Helpers for running a processor callback through the DataProcessor queue
// ---------------------------------------------------------------------------

/**
 * Feed an action trace through the DataProcessor, execute the queue,
 * then return. The processor must already have listeners registered.
 */
export async function processActionTrace<T>(
    processor: DataProcessor,
    db: ContractDBTransaction,
    block: ShipBlock,
    tx: EosioTransaction,
    trace: EosioActionTrace<T>,
): Promise<void> {
    processor.processActionTrace(block, tx, trace);
    await processor.executeHeadQueue(db);
}

/**
 * Feed a contract-row delta through the DataProcessor, execute the queue,
 * then return.
 */
export async function processContractRow<T>(
    processor: DataProcessor,
    db: ContractDBTransaction,
    block: ShipBlock,
    delta: EosioContractRow<T>,
): Promise<void> {
    processor.processContractRow(block, delta);
    await processor.executeHeadQueue(db);
}
