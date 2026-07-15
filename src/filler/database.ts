import { PoolClient, QueryResult } from 'pg';
import AwaitLock from 'await-lock';
// @ts-ignore
import exitHook from 'async-exit-hook';

import ConnectionManager from '../connections/manager';
import { ShipBlock } from '../types/ship';
import { eosioTimestampToDate } from '../utils/eosio';
import { arrayChunk, arraysEqual } from '../utils';
import { positiveIntEnv } from '../utils/env';
import logger from '../utils/winston';
import { EosioActionTrace, EosioTransaction } from '../types/eosio';
import { encodeDatabaseJson } from './utils';

// Per-transaction statement_timeout for the block WRITER, raised via `SET LOCAL`
// inside each writer transaction (see ContractDBTransaction.begin()).
//
// Why this exists: the `atomichub` role default is statement_timeout=30s (an
// API/query safety cap declared in the CNPG cluster manifest). The block writer
// groups up to db_group_blocks blocks (500 on WAX) into one transaction during
// catch-up; each buffered updateBatch flush is ~500 rows and fires the
// update_atomicmarket_sales_filters_by_asset() trigger + GIN inserts per row, and
// the COMMIT runs the DEFERRED FK checks. After a CNPG restart (cold cache + stale
// stats) a single chunk or the COMMIT can exceed 30s → 57014 → the consumer queue
// stops → the reader wedges → watchdog restart loop (2026-06-01 incident). The
// drain already raises its own statement_timeout for the same reason; the writer
// never did. Raising it lets fast catch-up batches actually commit WITHOUT
// shrinking db_group_blocks (fast replay is the goal, not the problem).
//
// 5 min default matches the drain's ATOMICMARKET_SALES_FILTERS_STATEMENT_TIMEOUT_MS
// and stays under READER_CATCHUP_STALL_TIMEOUT_MS (10m), so a genuinely stuck
// writer still surfaces via the reader watchdog rather than hanging forever.
// MUST go through positiveIntEnv: a raw 0 would emit `SET LOCAL statement_timeout
// = 0` which DISABLES the timeout (hang-forever) - the exact bug this prevents.
const WRITER_STATEMENT_TIMEOUT_MS = positiveIntEnv('FILLER_WRITER_STATEMENT_TIMEOUT_MS', 300_000);

export type Condition = {
    str: string,
    values: any[]
};

type SerializedValue = {
    type: string,
    data: any
};

function changeQueryVarOffset(str: string, length: number, offset: number): string {
    let queryStr = str;

    for (let i = length; i > 0; i--) {
        queryStr = queryStr.replace('$' + i, '$' + (offset + i));
    }

    return queryStr;
}

function removeIdenticalValues(
    currentValues: {[key: string]: any}, previousValues: {[key: string]: any}, primaryKey: string[] = []
): {[key: string]: any} {
    const keys = Object.keys(currentValues);
    const result: {[key: string]: any} = {};

    for (const key of keys) {
        if (primaryKey.indexOf(key) >= 0) {
            continue;
        }

        if (compareValues(currentValues[key], previousValues[key])) {
            continue;
        }

        result[key] = currentValues[key];
    }

    return result;
}

function serializeValue(value: any): SerializedValue {
    if (value instanceof Buffer) {
        return {
            type: 'bytes',
            data: [...value]
        };
    }

    if (ArrayBuffer.isView(value)) {
        return {
            type: 'bytes',
            data: [...Buffer.from(value.buffer, value.byteOffset, value.byteLength)]
        };
    }

    if (value instanceof Date) {
        return {
            type: 'date',
            data: value.getTime()
        };
    }

    return {
        type: 'raw',
        data: value
    };
}

function deserializeValue(value: SerializedValue): any {
    if (value.type === 'bytes') {
        return new Uint8Array(value.data);
    }

    if (value.type === 'date') {
        return new Date(value.data);
    }

    return value.data;
}

function compareValues(value1: any, value2: any): boolean {
    const serializedValue1 = serializeValue(value1);
    const serializedValue2 = serializeValue(value2);

    if (serializedValue1.type !== serializedValue2.type) {
        return false;
    }

    if (serializedValue1.type === 'bytes' && arraysEqual(serializedValue1.data, serializedValue2.data)) {
        return true;
    }

    if (serializedValue1.type === 'raw' && JSON.stringify(serializedValue1.data) === JSON.stringify(serializedValue2.data)) {
        return true;
    }

    return serializedValue1.data === serializedValue2.data;
}

function buildPrimaryCondition(values: {[key: string]: any}, primaryKey: string[], offset: number = 0): Condition {
    const conditionStr = primaryKey.map((key, index) => {
        return '"' + key + '" = $' + (offset + index + 1);
    }).join(' AND ');
    const conditionValues = primaryKey.map((key) => values[key]);

    return { str: conditionStr, values: conditionValues };
}

export interface ColumnMeta {
    pgType: string;   // format_type() output - directly usable as a cast target
    isArray: boolean; // array-typed column (typcategory 'A')
    notNull: boolean;
}

// Process-lifetime cache of per-table column metadata, keyed by bare table
// name. It is module-level - SHARED across every pooled connection - so an
// entry populated by one session is reused by all later sessions WITHOUT
// re-querying. That is sound here because of two invariants:
//   1. Every pool connection uses the same configured search_path, so a bare
//      table name resolves to the same relation regardless of which session
//      first looked it up.
//   2. updateBatch only ever targets persistent application tables (it is
//      called from the buffer flush in flushBuffers), whose schema is stable
//      for the process lifetime. The filler creates no temp tables, so there is
//      no session-local relation that could shadow a cached name. (Tests, which
//      do use temp tables, call __resetColumnMetaCache between cases.)
// If either invariant ever changes (per-session search_path, or temp tables in
// the write path), switch to a session-scoped cache key.
//
// Why catalog-driven instead of inferring the type from the JS values: value
// inference cannot know the type of an all-null batch column (it guessed
// `text`, producing unnest($N::text[]) → 42804 against e.g. a bigint column -
// the WAX filler stall at block #438032575), and it accreted special cases
// (empty arrays, decimal strings, mixed numerics) every time it guessed wrong
// on otherwise-legitimate data. The catalog is the source of truth.
const columnMetaCache = new Map<string, Promise<Map<string, ColumnMeta>>>();

// Test-only: drop cached metadata so each test reads the catalog fresh.
export function __resetColumnMetaCache(): void {
    columnMetaCache.clear();
}

async function loadColumnMeta(client: PoolClient, table: string): Promise<Map<string, ColumnMeta>> {
    const res = await client.query(
        `SELECT a.attname AS name,
                format_type(a.atttypid, a.atttypmod) AS pg_type,
                (t.typcategory = 'A') AS is_array,
                a.attnotnull AS not_null
           FROM pg_attribute a
           JOIN pg_type t ON t.oid = a.atttypid
          WHERE a.attrelid = to_regclass($1)
            AND a.attnum > 0
            AND NOT a.attisdropped`,
        [table],
    );

    const map = new Map<string, ColumnMeta>();
    for (const row of res.rows) {
        map.set(row.name, { pgType: row.pg_type, isArray: row.is_array, notNull: row.not_null });
    }
    return map;
}

function getColumnMeta(client: PoolClient, table: string): Promise<Map<string, ColumnMeta>> {
    let cached = columnMetaCache.get(table);
    if (!cached) {
        cached = loadColumnMeta(client, table);
        // A failed lookup must not poison the cache.
        cached.catch(() => columnMetaCache.delete(table));
        columnMetaCache.set(table, cached);
    }
    return cached;
}

export function isPkCondition(condition: Condition, primaryKey: string[]): boolean {
    const normalized = condition.str.replace(/"/g, '').trim();
    const expected = primaryKey.map((key, i) => key + ' = $' + (i + 1)).join(' AND ');
    return normalized === expected && condition.values.length === primaryKey.length;
}

export class WriteBuffer {
    private pending: Map<string, {
        table: string;
        rows: Record<string, any>[];
        pkIndex: Map<string, number>;
        primaryKey: string[];
        onConflict: 'update' | 'nothing' | 'error';
        reversible: boolean;
        updateBlacklist: string[];
    }> = new Map();

    get totalRows(): number {
        let n = 0;
        for (const batch of this.pending.values()) n += batch.rows.length;
        return n;
    }

    add(table: string, values: Record<string, any> | Record<string, any>[], primaryKey: string[],
        onConflict: 'update' | 'nothing' | 'error', reversible: boolean, updateBlacklist: string[] = []): void {
        const rows = Array.isArray(values) ? values : [values];
        if (rows.length === 0) return;

        const sortedKeys = Object.keys(rows[0]).sort();
        const columnKey = sortedKeys.join(',');
        const key = `${table}:${onConflict}:${primaryKey.join(',')}:${columnKey}:${updateBlacklist.join(',')}`;
        let batch = this.pending.get(key);
        if (!batch) {
            batch = { table, rows: [], pkIndex: new Map(), primaryKey, onConflict, reversible, updateBlacklist };
            this.pending.set(key, batch);
        }
        // Normalize key order so insertDirect's arraysEqual check passes
        const normalizedRows = rows.map(row => {
            const normalized: Record<string, any> = {};
            for (const k of sortedKeys) {
                normalized[k] = row[k];
            }
            return normalized;
        });
        // Deduplicate by PK within batch (last-write-wins) for upsert modes.
        // PG errors if the same PK appears twice in a single INSERT ... ON CONFLICT.
        // Skip dedup for onConflict='error' - duplicates should be impossible in catchup,
        // and if they occur the error is expected behavior.
        if (primaryKey.length > 0 && onConflict !== 'error') {
            for (const row of normalizedRows) {
                const pkHash = primaryKey.map(k => String(row[k])).join('\0');
                const existing = batch.pkIndex.get(pkHash);
                if (existing !== undefined) {
                    batch.rows[existing] = row;
                } else {
                    batch.pkIndex.set(pkHash, batch.rows.length);
                    batch.rows.push(row);
                }
            }
        } else {
            batch.rows.push(...normalizedRows);
        }
    }

    async flush(tx: ContractDBTransaction, lock: boolean = true): Promise<void> {
        for (const [, batch] of this.pending) {
            const numColumns = Object.keys(batch.rows[0]).length;
            const chunkSize = Math.min(Math.floor(65535 / numColumns), 500);
            const chunks = arrayChunk(batch.rows, chunkSize);
            for (const chunk of chunks) {
                await tx.insertDirect(batch.table, chunk, batch.primaryKey,
                    batch.reversible, lock, batch.onConflict, batch.updateBlacklist);
            }
        }
        this.pending.clear();
    }

    clear(): void {
        this.pending.clear();
    }
}

export class UpdateBuffer {
    private pending: Map<string, {
        table: string;
        pkColumns: string[];
        pkValues: Record<string, any>;
        setValues: Record<string, any>;
    }> = new Map();

    get totalRows(): number {
        return this.pending.size;
    }

    add(table: string, values: Record<string, any>, condition: Condition, primaryKey: string[]): void {
        const pkValues: Record<string, any> = {};
        for (let i = 0; i < primaryKey.length; i++) {
            pkValues[primaryKey[i]] = condition.values[i];
        }

        const pkHash = primaryKey.map(k => String(pkValues[k])).join('\0');
        const key = `${table}:${pkHash}`;

        const existing = this.pending.get(key);
        if (existing) {
            // Merge set values (last-write-wins), filtering out PK columns
            for (const [k, v] of Object.entries(values)) {
                if (primaryKey.indexOf(k) === -1) {
                    existing.setValues[k] = v;
                }
            }
        } else {
            const setValues: Record<string, any> = {};
            for (const [k, v] of Object.entries(values)) {
                if (primaryKey.indexOf(k) === -1) {
                    setValues[k] = v;
                }
            }
            this.pending.set(key, { table, pkColumns: primaryKey, pkValues, setValues });
        }
    }

    async flush(tx: ContractDBTransaction, lock: boolean = true): Promise<void> {
        if (this.pending.size === 0) return;

        // Group by (table, pkColumns, setColumns) for batch UPDATE FROM unnest()
        const groups: Map<string, {
            table: string;
            pkColumns: string[];
            setColumns: string[];
            rows: { pkValues: Record<string, any>; setValues: Record<string, any> }[];
        }> = new Map();

        for (const entry of this.pending.values()) {
            const setColumns = Object.keys(entry.setValues).sort();
            const groupKey = `${entry.table}:${entry.pkColumns.join(',')}:${setColumns.join(',')}`;

            let group = groups.get(groupKey);
            if (!group) {
                group = { table: entry.table, pkColumns: entry.pkColumns, setColumns, rows: [] };
                groups.set(groupKey, group);
            }
            group.rows.push({ pkValues: entry.pkValues, setValues: entry.setValues });
        }

        for (const group of groups.values()) {
            const chunks = arrayChunk(group.rows, 500);
            for (const chunk of chunks) {
                await tx.updateBatch(group.table, group.pkColumns, group.setColumns, chunk, lock);
            }
        }

        this.pending.clear();
    }

    clear(): void {
        this.pending.clear();
    }
}

export class ContractDB {
    static transactions: ContractDBTransaction[] = [];

    public stats: {operations: number};

    constructor(readonly name: string, readonly connection: ConnectionManager) {
        this.stats = {operations: 0};
    }

    async startTransaction(currentBlock?: number): Promise<ContractDBTransaction> {
        const client = await this.connection.database.pool.connect();

        this.stats.operations = this.stats.operations % Math.pow(2, 32);

        const tx = new ContractDBTransaction(client, this.name, this.stats, currentBlock);

        if (!currentBlock) {
            tx.enableWriteBuffer();
        }

        return tx;
    }

    async fetchAbi(contract: string, blockNum: number): Promise<{data: Uint8Array, block_num: number} | null> {
        const query = await this.connection.database.query(
            'SELECT block_num, abi FROM contract_abis WHERE account = $1 AND block_num <= $2 ORDER BY block_num DESC LIMIT 1',
            [contract, blockNum]
        );

        if (query.rows.length === 0) {
            return null;
        }

        return {
            data: query.rows[0].abi,
            block_num: parseInt(query.rows[0].block_num, 10)
        };
    }

    async fetchNextAbi(contract: string, blockNum: number): Promise<{data: Uint8Array, block_num: number} | null> {
        const query = await this.connection.database.query(
            'SELECT block_num, abi FROM contract_abis WHERE account = $1 AND block_num > $2 ORDER BY block_num ASC LIMIT 1',
            [contract, blockNum]
        );

        if (query.rows.length === 0) {
            return null;
        }

        return {
            data: query.rows[0].abi,
            block_num: parseInt(query.rows[0].block_num, 10)
        };
    }

    // Reversible bookkeeping below the fork-guard floor is unreachable by any
    // legitimate rollback (LIB-driven pruning normally removes it; rows this old
    // survive only when a past crash skipped that prune) and is pure fuel for an
    // illegitimate deep rollback. Runs once per reader startup.
    async cleanupStaleReversibleData(reader: string, floorBlock: number): Promise<void> {
        const queries = await this.connection.database.query(
            'DELETE FROM reversible_queries WHERE reader = $1 AND block_num < $2',
            [reader, floorBlock]
        );
        const blocks = await this.connection.database.query(
            'DELETE FROM reversible_blocks WHERE reader = $1 AND block_num < $2',
            [reader, floorBlock]
        );

        if (queries.rowCount > 0 || blocks.rowCount > 0) {
            logger.warn(
                'Pruned stale reversible bookkeeping below block #' + floorBlock +
                ' (' + queries.rowCount + ' queries, ' + blocks.rowCount + ' blocks) for reader ' + reader
            );
        }
    }

    async getReaderPosition(): Promise<{ live: boolean, block_num: number, updated: number }> {
        const query = await this.connection.database.query('SELECT live, block_num, updated FROM contract_readers WHERE name = $1', [this.name]);

        if (query.rows.length === 0) {
            return {
                live: false,
                block_num: 0,
                updated: 0
            };
        }

        return {
            live: query.rows[0].live,
            block_num: parseInt(query.rows[0].block_num, 10),
            updated: parseInt(query.rows[0].updated, 10)
        };
    }

    async getLastReaderBlocks(): Promise<Array<{block_num: number, block_id: string}>> {
        const query = await this.connection.database.query(
            'SELECT block_num, encode(block_id::bytea, \'hex\') block_id FROM reversible_blocks WHERE reader = $1 ORDER BY block_num ASC',
            [this.name]
        );

        return query.rows;
    }
}

export class ContractDBTransaction {
    readonly lock: AwaitLock;

    inTransaction: boolean;
    committed: boolean;

    actionLogs: any[];
    writeBuffer: WriteBuffer | null;
    updateBuffer: UpdateBuffer | null;

    constructor(
        readonly client: PoolClient, readonly name: string, readonly stats: {operations: number}, readonly currentBlock?: number
    ) {
        this.lock = new AwaitLock();
        this.committed = false;
        this.inTransaction = false;

        this.actionLogs = [];
        this.writeBuffer = null;
        this.updateBuffer = null;
    }

    enableWriteBuffer(): void {
        this.writeBuffer = new WriteBuffer();
        this.updateBuffer = new UpdateBuffer();
    }

    async begin(): Promise<void> {
        if (this.inTransaction) {
            return;
        }

        this.inTransaction = true;

        await this.clientQuery('BEGIN');
        await this.clientQuery('SET LOCAL synchronous_commit = off');
        await this.clientQuery('SET CONSTRAINTS ALL DEFERRED');
        // Raise statement_timeout above the role's 30s default so a large
        // catch-up batch (and its deferred-FK COMMIT) can finish. SET LOCAL is
        // pgbouncer-safe and reverts at COMMIT. See WRITER_STATEMENT_TIMEOUT_MS.
        await this.clientQuery('SET LOCAL statement_timeout = ' + Number(WRITER_STATEMENT_TIMEOUT_MS));

        ContractDB.transactions.push(this);
    }

    private async flushBuffers(lock: boolean): Promise<void> {
        if (this.writeBuffer && this.writeBuffer.totalRows > 0) {
            await this.writeBuffer.flush(this, lock);
        }
        if (this.updateBuffer && this.updateBuffer.totalRows > 0) {
            await this.updateBuffer.flush(this, lock);
        }
    }

    async query(queryStr: string, values: any[] = [], lock: boolean = true): Promise<QueryResult> {
        await this.acquireLock(lock);

        try {
            await this.flushBuffers(false);

            await this.begin();

            return await this.clientQuery(queryStr, values);
        } finally {
            this.releaseLock(lock);
        }
    }

    async insert(
        table: string, values: Record<string, any>, primaryKey: string[],
        reversible: boolean = true, lock: boolean = true,
        onConflict: 'update' | 'nothing' | 'error' = 'error',
        updateBlacklist: string[] = []
    ): Promise<QueryResult> {
        if (this.writeBuffer) {
            this.writeBuffer.add(table, values, primaryKey, onConflict, reversible, updateBlacklist);
            const rowCount = Array.isArray(values) ? values.length : 1;
            return { rowCount, rows: [], command: 'INSERT', oid: 0, fields: [] } as QueryResult;
        }

        return this.insertDirect(table, values, primaryKey, reversible, lock, onConflict, updateBlacklist);
    }

    async insertDirect(
        table: string, values: Record<string, any>, primaryKey: string[],
        reversible: boolean = true, lock: boolean = true,
        onConflict: 'update' | 'nothing' | 'error' = 'error',
        updateBlacklist: string[] = []
    ): Promise<QueryResult> {
        await this.acquireLock(lock);

        try {
            await this.begin();

            let insertValues: {[key: string]: any}[];

            if (!Array.isArray(values)) {
                insertValues = [values];
            } else {
                insertValues = values;
            }

            if (insertValues.length === 0 || typeof insertValues[0] !== 'object') {
                throw new Error('ContractDB invalid insert values');
            }

            const keys = Object.keys(insertValues[0]);
            const queryValues = [];
            const queryRows = [];

            let varCounter = 1;

            for (const vals of insertValues) {
                if (!arraysEqual(keys, Object.keys(vals))) {
                    throw new Error('Different insert keys on mass insert');
                }

                const rowVars = [];

                for (const key of keys) {
                    queryValues.push(vals[key]);
                    rowVars.push('$' + varCounter);
                    varCounter += 1;
                }

                queryRows.push('(' + rowVars.join(', ') + ')');
            }

            let queryStr = 'INSERT INTO ' + this.client.escapeIdentifier(table) + ' ';
            queryStr += '(' + keys.map(this.client.escapeIdentifier).join(', ') + ') ';
            queryStr += 'VALUES ' + queryRows.join(', ') + ' ';

            if (onConflict === 'update' && primaryKey.length > 0) {
                const conflictKeys = primaryKey.map(key => this.client.escapeIdentifier(key)).join(', ');
                const updateCols = keys
                    .filter(key => primaryKey.indexOf(key) === -1)
                    .filter(key => updateBlacklist.indexOf(key) === -1)
                    .map(key => this.client.escapeIdentifier(key) + ' = EXCLUDED.' + this.client.escapeIdentifier(key));

                if (updateCols.length > 0) {
                    queryStr += 'ON CONFLICT (' + conflictKeys + ') DO UPDATE SET ' + updateCols.join(', ') + ' ';
                } else {
                    queryStr += 'ON CONFLICT (' + conflictKeys + ') DO NOTHING ';
                }
            } else if (onConflict === 'nothing') {
                if (primaryKey.length > 0) {
                    queryStr += 'ON CONFLICT (' + primaryKey.map(key => this.client.escapeIdentifier(key)).join(', ') + ') DO NOTHING ';
                } else {
                    queryStr += 'ON CONFLICT DO NOTHING ';
                }
            }

            if (primaryKey.length > 0) {
                queryStr += 'RETURNING ' + primaryKey.map(key => this.client.escapeIdentifier(key)).join(', ') + ' ';
            }

            queryStr += ';';

            const query = await this.clientQuery(queryStr, queryValues);

            this.stats.operations += query.rowCount;

            if (primaryKey.length > 0 && this.currentBlock && reversible) {
                const rollbacks = [];

                for (const row of query.rows) {
                    rollbacks.push(this.buildRollbackQuery('delete', table, null, buildPrimaryCondition(row, primaryKey)));
                }

                await this.saveRollbackQueries(rollbacks);
            }

            return query;
        } finally {
            this.releaseLock(lock);
        }
    }

    async updateBatch(
        table: string, pkColumns: string[], setColumns: string[],
        rows: { pkValues: Record<string, any>; setValues: Record<string, any> }[],
        lock: boolean = true
    ): Promise<QueryResult> {
        await this.acquireLock(lock);

        try {
            await this.begin();

            const allColumns = [...pkColumns, ...setColumns];
            const columnArrays: any[][] = allColumns.map(() => []);

            for (const row of rows) {
                for (let i = 0; i < pkColumns.length; i++) {
                    columnArrays[i].push(row.pkValues[pkColumns[i]]);
                }
                for (let i = 0; i < setColumns.length; i++) {
                    columnArrays[pkColumns.length + i].push(row.setValues[setColumns[i]]);
                }
            }

            // Cast types come from the live catalog, not from guessing at the
            // JS values. This also lets us fail loud - at the writer boundary,
            // with an accurately located message - on the two programming errors
            // value inference could only surface as a confusing downstream
            // Postgres error: a NULL for a NOT NULL column, or a key that isn't
            // a real column.
            const meta = await getColumnMeta(this.client, table);
            const at = ' (reader ' + this.name + ', block ' + (this.currentBlock ?? 'N/A') + ')';
            if (meta.size === 0) {
                throw new Error('updateBatch: table "' + table + '" not found in the catalog' + at);
            }

            const pgTypes: string[] = [];
            const isArrayColumn: boolean[] = [];
            for (let i = 0; i < allColumns.length; i++) {
                const col = allColumns[i];
                const cm = meta.get(col);
                if (!cm) {
                    throw new Error('updateBatch: column "' + col + '" does not exist on "' + table + '"' + at);
                }
                if (cm.notNull && columnArrays[i].some(v => v === null || v === undefined)) {
                    throw new Error(
                        'updateBatch: NULL written to NOT NULL column "' + table + '"."' + col + '"' + at +
                        ' - a handler passed null/undefined for a required column'
                    );
                }
                pgTypes.push(cm.pgType);
                isArrayColumn.push(cm.isArray);
            }

            // PG's unnest($::T[][]) flattens multidim arrays completely, so
            // array-typed columns can't go through the unnest path - they need
            // the VALUES-clause path with per-row casts that preserve row
            // structure. format_type() already yields the full array type
            // (e.g. `jsonb[]`), so no per-row suffix is appended below.
            const requiresValuesPath = isArrayColumn.some(b => b);

            const esc = this.client.escapeIdentifier.bind(this.client);
            const setClause = setColumns.map(c => esc(c) + ' = u.' + esc(c)).join(', ');
            const whereClause = pkColumns.map(c => 't.' + esc(c) + ' = u.' + esc(c)).join(' AND ');
            const colAliases = allColumns.map(c => esc(c)).join(', ');

            let sql: string;
            let queryValues: any[];

            if (requiresValuesPath) {
                const valueRows = rows.map((_, rowIdx) => {
                    const placeholders = allColumns.map((_c, colIdx) => {
                        const paramIdx = rowIdx * allColumns.length + colIdx + 1;
                        // pgType is the real column type (scalar for non-array
                        // columns, full `T[]` for array columns) - one value per
                        // row, so no extra suffix.
                        return '$' + paramIdx + '::' + pgTypes[colIdx];
                    });
                    return '(' + placeholders.join(', ') + ')';
                }).join(', ');

                sql = 'UPDATE ' + esc(table) + ' AS t SET ' + setClause +
                    ' FROM (VALUES ' + valueRows + ') AS u(' + colAliases + ')' +
                    ' WHERE ' + whereClause + ';';

                queryValues = rows.flatMap(row => [
                    ...pkColumns.map(c => row.pkValues[c]),
                    ...setColumns.map(c => row.setValues[c]),
                ]);
            } else {
                // Scalar-only batch: no column carries per-row array values
                // (the array-column case takes the requiresValuesPath branch
                // above). Every parameter is a flat 1-D array unnested into
                // its column, so the type suffix is always `[]`.
                const unnestParams = columnArrays.map((_arr, i) =>
                    '$' + (i + 1) + '::' + pgTypes[i] + '[]',
                ).join(', ');

                sql = 'UPDATE ' + esc(table) + ' AS t SET ' + setClause +
                    ' FROM unnest(' + unnestParams + ') AS u(' + colAliases + ')' +
                    ' WHERE ' + whereClause + ';';

                queryValues = columnArrays;
            }

            const result = await this.clientQuery(sql, queryValues);
            this.stats.operations += result.rowCount;

            if (result.rowCount < rows.length) {
                logger.warn(
                    'Batch UPDATE on ' + table + ' affected ' + result.rowCount + ' rows, expected ' + rows.length +
                    '. Reader: ' + this.name + ', Block: ' + (this.currentBlock || 'N/A')
                );
            }

            return result;
        } finally {
            this.releaseLock(lock);
        }
    }

    async update(
        table: string, values: {[key: string]: any}, condition: Condition,
        primaryKey: string[], reversible: boolean = true, lock: boolean = true
    ): Promise<QueryResult> {
        if (this.updateBuffer && primaryKey.length > 0 && isPkCondition(condition, primaryKey)) {
            this.updateBuffer.add(table, values, condition, primaryKey);
            return { rowCount: 1, rows: [], command: 'UPDATE', oid: 0, fields: [] } as QueryResult;
        }

        await this.acquireLock(lock);

        try {
            await this.flushBuffers(false);

            await this.begin();

            let selectQuery = null;
            if (this.currentBlock && reversible) {
                const selectKeys = Object.keys(values);

                for (const key of primaryKey) {
                    if (selectKeys.indexOf(key) === -1) {
                        selectKeys.push(key);
                    }
                }

                selectQuery = await this.clientQuery(
                    'SELECT ' + selectKeys.map(key => '"' + key + '"').join(', ') + ' FROM ' + this.client.escapeIdentifier(table) + ' WHERE ' + condition.str + ';', condition.values
                );
            }

            const keys = Object.keys(values);
            const queryUpdates = [];

            let queryValues = [];
            let varCounter = 0;

            for (const key of keys) {
                if (primaryKey.indexOf(key) >= 0) {
                    continue;
                }

                varCounter += 1;
                queryUpdates.push('' + this.client.escapeIdentifier(key) + ' = $' + varCounter);
                queryValues.push(values[key]);
            }

            let queryStr = 'UPDATE ' + this.client.escapeIdentifier(table) + ' SET ';
            queryStr += queryUpdates.join(', ') + ' ';
            queryStr += 'WHERE ' + changeQueryVarOffset(condition.str, condition.values.length, varCounter) + ' ';

            if (primaryKey.length > 0) {
                queryStr += 'RETURNING ' + primaryKey.map(key => this.client.escapeIdentifier(key)).join(', ') + ' ';
            }

            queryValues = queryValues.concat(condition.values);

            const query = await this.clientQuery(queryStr, queryValues);

            this.stats.operations += query.rowCount;

            if (query.rowCount === 0) {
                logger.warn(
                    'Table ' + table + ' update affected 0 rows (possible fork replay). ' +
                    'Reader: ' + this.name + ', Block: ' + (this.currentBlock || 'N/A') + '. ' +
                    'Values: ' + JSON.stringify(values) + ', Condition: ' + JSON.stringify(condition)
                );
            }

            if (selectQuery && selectQuery.rows.length > 0) {
                const rollbacks = [];

                for (const row of selectQuery.rows) {
                    const filteredValues = removeIdenticalValues(row, values, primaryKey);

                    if (Object.keys(filteredValues).length === 0) {
                        continue;
                    }

                    rollbacks.push(await this.buildRollbackQuery('update', table, filteredValues, buildPrimaryCondition(row, primaryKey)));
                }

                await this.saveRollbackQueries(rollbacks);
            }

            return query;
        } finally {
            this.releaseLock(lock);
        }
    }

    async delete(
        table: string, condition: Condition, reversible: boolean = true, lock: boolean = true
    ): Promise<QueryResult> {
        await this.acquireLock(lock);

        try {
            await this.flushBuffers(false);

            await this.begin();

            let selectQuery;
            if (this.currentBlock && reversible) {
                selectQuery = await this.clientQuery(
                    'SELECT * FROM ' + this.client.escapeIdentifier(table) + ' WHERE ' + condition.str + ';', condition.values
                );
            }

            const queryStr = 'DELETE FROM ' + this.client.escapeIdentifier(table) + ' WHERE ' + condition.str + ';';
            const query = await this.clientQuery(queryStr, condition.values);

            this.stats.operations += selectQuery ? selectQuery.rowCount : 1;

            if (selectQuery && selectQuery.rows.length > 0) {
                const rollback = this.buildRollbackQuery('insert', table, selectQuery.rows);

                await this.saveRollbackQueries([rollback]);
            }

            return query;
        } finally {
            this.releaseLock(lock);
        }
    }

    async replace(
        table: string, values: Record<string, any>, primaryKey: string[], updateBlacklist: string[] = [],
        reversible: boolean = true, lock: boolean = true
    ): Promise<QueryResult> {
        if (this.writeBuffer) {
            return this.insert(table, values, primaryKey, false, lock, 'update', updateBlacklist);
        }

        await this.acquireLock(lock);

        try {
            await this.flushBuffers(false);

            await this.begin();

            const condition = buildPrimaryCondition(values, primaryKey);
            const selectQuery = await this.clientQuery(
                'SELECT * FROM ' + this.client.escapeIdentifier(table) + ' WHERE ' + condition.str + ' LIMIT 1;', condition.values
            );

            if (selectQuery.rows.length > 0) {
                const updateValues: {[key: string]: any} = {...values};

                for (const key of updateBlacklist) {
                    delete updateValues[key];
                }

                for (const key of primaryKey) {
                    delete updateValues[key];
                }

                await this.update(table, updateValues, condition, primaryKey, false, false);

                if (this.currentBlock && reversible) {
                    const filteredValues = removeIdenticalValues(selectQuery.rows[0], updateValues, primaryKey);

                    if (Object.keys(filteredValues).length > 0) {
                        const rollback = await this.buildRollbackQuery('update', table, filteredValues, condition);

                        await this.saveRollbackQueries([rollback]);
                    }
                }
            } else {
                return await this.insert(table, values, primaryKey, reversible, false);
            }
        } finally {
            this.releaseLock(lock);
        }
    }

    async saveRollbackQueries(data: any[]): Promise<void> {
        if (data.length === 0) {
            return;
        }

        const chunks = arrayChunk(data, 100);

        for (const chunk of chunks) {
            await this.insert('reversible_queries', chunk, [], false, false);
        }
    }

    buildRollbackQuery(operation: string, table: string, values: any, condition?: Condition): any {
        let serializedCondition = null;
        if (condition) {
            serializedCondition = {
                str: condition.str,
                values: condition.values.map((value) => serializeValue(value))
            };
        }

        let serializedValues: any = null;
        if (Array.isArray(values)) {
            serializedValues = [];

            for (const value of values) {
                const row = {...value};

                for (const key of Object.keys(value)) {
                    row[key] = serializeValue(value[key]);
                }

                serializedValues.push(row);
            }
        } else if (values) {
            serializedValues = {...values};

            for (const key of Object.keys(serializedValues)) {
                serializedValues[key] = serializeValue(values[key]);
            }
        }

        return {
            operation, table,
            values: JSON.stringify(serializedValues),
            condition: JSON.stringify(serializedCondition),
            block_num: this.currentBlock, reader: this.name
        };
    }

    async rollbackReversibleBlocks(blockNum: number, lock: boolean = true): Promise<void> {
        await this.acquireLock(lock);

        try {
            await this.begin();

            const countResult = await this.clientQuery(
                'SELECT COUNT(*)::int AS total FROM reversible_queries WHERE block_num >= $1 AND reader = $2',
                [blockNum, this.name]
            );
            const total = countResult.rows[0].total;

            logger.info('Rollback ' + total + ' operations until block #' + blockNum + ' (chunked)');

            const startTime = Date.now();
            // CHUNK_SIZE bounds each inner transaction - keeps any single
            // COMMIT-to-COMMIT window small enough that a slow per-row query
            // (e.g. contract_traces DELETE without a B-tree point-lookup index)
            // cannot exceed statement_timeout on a genuine fork rollback.
            // 100 matches the arrayChunk(data, 100) pattern used in commit().
            const CHUNK_SIZE = 100;
            let counter = 0;
            let lastProgressMessage = Date.now();

            while (counter < total) {
                // Fetch next chunk by id. Previous chunks are DELETEd below,
                // so no OFFSET is needed - each LIMIT reads fresh rows.
                const chunk = await this.clientQuery(
                    'SELECT id, operation, "table", "values", condition ' +
                    'FROM reversible_queries WHERE block_num >= $1 AND reader = $2 ' +
                    'ORDER BY block_num DESC, id DESC LIMIT $3',
                    [blockNum, this.name, CHUNK_SIZE]
                );

                if (chunk.rowCount === 0) {
                    break;
                }

                const chunkIds: number[] = [];

                for (const row of chunk.rows) {
                    const values = row.values;
                    const condition: Condition | null = row.condition;

                    if (condition) {
                        condition.values = condition.values.map((value) => deserializeValue(value));
                    }

                    if (values !== null) {
                        if (Array.isArray(values)) {
                            for (const value of values) {
                                for (const key of Object.keys(value)) {
                                    value[key] = deserializeValue(value[key]);
                                }
                            }
                        } else {
                            for (const key of Object.keys(values)) {
                                values[key] = deserializeValue(values[key]);
                            }
                        }
                    }

                    if (Date.now() - startTime >= 30000) {
                        logger.warn('Fork rollback taking longer than expected. Executing query...', {
                            operation: row.operation,
                            table: row.table,
                            values, condition
                        });
                    }

                    if (row.operation === 'insert') {
                        await this.insert(row.table, values, [], false, false);
                    } else if (row.operation === 'update') {
                        try {
                            await this.update(row.table, values, condition, [], false, false);
                        } catch (e: any) {
                            if (e.message && e.message.includes('update affected 0 rows')) {
                                logger.warn('Rollback update affected 0 rows (row may have been removed by a prior rollback operation)', {
                                    table: row.table, values, condition
                                });
                            } else {
                                throw e;
                            }
                        }
                    } else if (row.operation === 'delete') {
                        await this.delete(row.table, condition, false, false);
                    } else {
                        throw Error('Invalid rollback operation in database');
                    }

                    chunkIds.push(row.id);
                    counter += 1;

                    if (Date.now() - lastProgressMessage >= 5000) {
                        logger.info('Executed rollback query ' + counter + ' / ' + total);

                        lastProgressMessage = Date.now();
                    }
                }

                // Delete just the rows we processed this chunk, then commit so
                // the per-chunk transaction stays inside statement_timeout even
                // if one of the ops is slow. Fork rollback is already the
                // primary source of inconsistency visibility between fork
                // detection and checkpoint advance - chunking doesn't add a
                // new window, it just makes each internal commit smaller.
                await this.clientQuery(
                    'DELETE FROM reversible_queries WHERE id = ANY($1::bigint[])',
                    [chunkIds]
                );
                await this.clientQuery('COMMIT');
                this.inTransaction = false;

                // Reopen a transaction for the next chunk - begin() is
                // idempotent, so the insert/update/delete helpers above
                // would otherwise reopen it lazily on the next op.
                await this.begin();
            }

            // Final cleanup runs inside the transaction the caller will
            // commit alongside processing of the post-fork block.
            await this.clientQuery(
                'DELETE FROM reversible_blocks WHERE block_num >= $1 AND reader = $2;',
                [blockNum, this.name]
            );

            await this.clientQuery(
                'UPDATE contract_readers SET block_num = $1 WHERE name = $2;',
                [blockNum - 1, this.name]
            );
        } finally {
            this.releaseLock(lock);
        }
    }

    async clearForkDatabase(lastIrreversibleBlock: number, lock: boolean = true): Promise<void> {
        await this.acquireLock(lock);

        try {
            await this.begin();

            await this.clientQuery(
                'DELETE FROM reversible_queries WHERE block_num <= $1 AND reader = $2',
                [lastIrreversibleBlock, this.name]
            );

            await this.clientQuery(
                'DELETE FROM reversible_blocks WHERE block_num <= $1 AND reader = $2',
                [lastIrreversibleBlock, this.name]
            );
        } finally {
            this.releaseLock(lock);
        }
    }

    async updateReaderPosition(block: ShipBlock, live: boolean, lock: boolean = true): Promise<void> {
        await this.acquireLock(lock);

        try {
            await this.begin();

            await this.clientQuery(
                'UPDATE contract_readers SET block_num = $1, block_time = $2, updated = $3, live = $4 WHERE name = $5',
                [block.block_num, eosioTimestampToDate(block.timestamp).getTime(), Date.now(), live, this.name]
            );
        } finally {
            this.releaseLock(lock);
        }
    }

    async logTrace(block: ShipBlock, tx: EosioTransaction, trace: EosioActionTrace, metadata: any): Promise<void> {
        this.actionLogs.push({
            global_sequence: trace.global_sequence,
            account: trace.act.account,
            name: trace.act.name,
            metadata: encodeDatabaseJson(metadata),
            txid: Buffer.from(tx.id, 'hex'),
            created_at_block: block.block_num,
            created_at_time: eosioTimestampToDate(block.timestamp).getTime()
        });
    }

    async commit(): Promise<void> {
        await this.flushBuffers(true);

        if (this.actionLogs.length > 0) {
            const chunks = arrayChunk(this.actionLogs, 100);

            for (const chunk of chunks) {
                await this.insert('contract_traces', chunk, ['global_sequence', 'account']);
            }

            this.actionLogs = [];
        }

        await this.acquireLock();

        try {
            if (this.inTransaction) {
                await this.clientQuery('COMMIT');
            }
        } finally {
            this.client.release();

            this.releaseLock();

            const index = ContractDB.transactions.indexOf(this);

            if (index >= 0) {
                ContractDB.transactions.splice(index, 1);
            }
        }
    }

    async abort(): Promise<void> {
        if (this.writeBuffer) {
            this.writeBuffer.clear();
        }
        if (this.updateBuffer) {
            this.updateBuffer.clear();
        }

        await this.acquireLock();

        try {
            if (this.inTransaction) {
                await this.clientQuery('ROLLBACK');
            }
        } finally {
            this.releaseLock();
            this.client.release();

            const index = ContractDB.transactions.indexOf(this);
            if (index >= 0) {
                ContractDB.transactions.splice(index, 1);
            }
        }
    }

    private async clientQuery(queryText: string, values: any[] = []): Promise<QueryResult> {
        try {
            logger.debug('contract db query: ' + queryText, values);

            return await this.client.query(queryText, values);
        } catch (error) {
            logger.error('Failed to execute SQL query ', {queryText, values, error});

            throw error;
        }
    }

    private async acquireLock(lock: boolean = true): Promise<void> {
        if (!lock) {
            return;
        }

        await this.lock.acquireAsync();
    }

    private releaseLock(lock: boolean = true): void {
        if (!lock) {
            return;
        }

        this.lock.release();
    }
}

exitHook(async (callback: () => void) => {
    logger.info('Process stopping - cleaning up transactions...');

    for (const transaction of ContractDB.transactions) {
        await transaction.abort();
    }

    logger.info('All transactions aborted');

    callback();
});
