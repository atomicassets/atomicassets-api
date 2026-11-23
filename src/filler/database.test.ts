import { describe, expect, it } from 'vitest';
import { WriteBuffer, UpdateBuffer, isPkCondition } from './database';

describe('WriteBuffer flush() unit tests', () => {
    it('calls insertDirect for each batch and clears pending', async () => {
        const buffer = new WriteBuffer();

        buffer.add('table_a', {id: 1, val: 'a'}, ['id'], 'update', false);
        buffer.add('table_a', {id: 2, val: 'b'}, ['id'], 'update', false);
        buffer.add('table_b', {id: 1, name: 'x'}, ['id'], 'nothing', true);

        const calls: any[] = [];
        const fakeTx = {
            insertDirect: async (...args: any[]) => {
                calls.push(args);
            }
        } as any;

        await buffer.flush(fakeTx, false);

        // Should have made 2 calls (2 different batches)
        expect(calls.length).to.equal(2);

        // table_a batch should have 2 rows
        const tableACalls = calls.filter(c => c[0] === 'table_a');
        expect(tableACalls.length).to.equal(1);
        expect(tableACalls[0][1].length).to.equal(2); // 2 rows
        expect(tableACalls[0][2]).to.deep.equal(['id']); // primaryKey
        expect(tableACalls[0][3]).to.equal(false); // reversible
        expect(tableACalls[0][4]).to.equal(false); // lock (passed from flush)
        expect(tableACalls[0][5]).to.equal('update'); // onConflict
        expect(tableACalls[0][6]).to.deep.equal([]); // updateBlacklist

        // table_b batch should have 1 row
        const tableBCalls = calls.filter(c => c[0] === 'table_b');
        expect(tableBCalls.length).to.equal(1);
        expect(tableBCalls[0][1].length).to.equal(1);
        expect(tableBCalls[0][3]).to.equal(true); // reversible
        expect(tableBCalls[0][5]).to.equal('nothing'); // onConflict

        // Buffer should be cleared after flush
        expect(buffer.totalRows).to.equal(0);
    });

    it('passes updateBlacklist through to insertDirect', async () => {
        const buffer = new WriteBuffer();

        buffer.add('t', {id: 1, a: 1, b: 2}, ['id'], 'update', false, ['a']);

        const calls: any[] = [];
        const fakeTx = {
            insertDirect: async (...args: any[]) => { calls.push(args); }
        } as any;

        await buffer.flush(fakeTx, true);

        expect(calls.length).to.equal(1);
        expect(calls[0][6]).to.deep.equal(['a']);
    });

    it('chunks large batches to stay within parameter limit', async () => {
        const buffer = new WriteBuffer();

        // Add 600 rows with 2 columns each.
        // chunkSize = min(floor(65535/2), 500) = 500
        // So 600 rows should split into 2 chunks: 500 + 100
        const rows = Array.from({length: 600}, (_, i) => ({id: i, val: 'x'}));
        buffer.add('t', rows, ['id'], 'update', false);

        expect(buffer.totalRows).to.equal(600);

        const calls: any[] = [];
        const fakeTx = {
            insertDirect: async (...args: any[]) => { calls.push(args); }
        } as any;

        await buffer.flush(fakeTx);

        expect(calls.length).to.equal(2);
        expect(calls[0][1].length).to.equal(500);
        expect(calls[1][1].length).to.equal(100);
    });

    it('chunks large batches when many columns reduce the chunk size', async () => {
        const buffer = new WriteBuffer();

        // 200 columns: chunkSize = floor(65535/200) = 327
        // Add 400 rows => 2 chunks: 327 + 73
        const row: Record<string, any> = {id: 0};
        for (let c = 0; c < 199; c++) row['col_' + c] = 'v';

        const rows = Array.from({length: 400}, (_, i) => ({...row, id: i}));
        buffer.add('t', rows, ['id'], 'update', false);

        const calls: any[] = [];
        const fakeTx = {
            insertDirect: async (...args: any[]) => { calls.push(args); }
        } as any;

        await buffer.flush(fakeTx);

        expect(calls.length).to.equal(2);
        expect(calls[0][1].length).to.equal(327);
        expect(calls[1][1].length).to.equal(73);
    });

    it('flush on empty buffer is a no-op', async () => {
        const buffer = new WriteBuffer();
        const calls: any[] = [];
        const fakeTx = {
            insertDirect: async (...args: any[]) => { calls.push(args); }
        } as any;

        await buffer.flush(fakeTx);

        expect(calls.length).to.equal(0);
        expect(buffer.totalRows).to.equal(0);
    });
});

describe('UpdateBuffer flush() unit tests', () => {
    it('calls updateBatch grouped by (table, pkColumns, setColumns)', async () => {
        const buffer = new UpdateBuffer();

        // Two rows in same table, same PK columns, same set columns
        buffer.add('t', {val: 'a'}, {str: 'id = $1', values: [1]}, ['id']);
        buffer.add('t', {val: 'b'}, {str: 'id = $1', values: [2]}, ['id']);

        const calls: any[] = [];
        const fakeTx = {
            updateBatch: async (...args: any[]) => { calls.push(args); }
        } as any;

        await buffer.flush(fakeTx, false);

        expect(calls.length).to.equal(1);
        expect(calls[0][0]).to.equal('t');         // table
        expect(calls[0][1]).to.deep.equal(['id']);  // pkColumns
        expect(calls[0][2]).to.deep.equal(['val']); // setColumns (sorted)
        expect(calls[0][3].length).to.equal(2);     // 2 rows
        expect(calls[0][4]).to.equal(false);         // lock

        expect(buffer.totalRows).to.equal(0);
    });

    it('creates separate groups for different setColumns', async () => {
        const buffer = new UpdateBuffer();

        buffer.add('t', {val_a: 'x'}, {str: 'id = $1', values: [1]}, ['id']);
        buffer.add('t', {val_b: 'y'}, {str: 'id = $1', values: [2]}, ['id']);

        const calls: any[] = [];
        const fakeTx = {
            updateBatch: async (...args: any[]) => { calls.push(args); }
        } as any;

        await buffer.flush(fakeTx);

        // Different set columns → 2 separate groups
        expect(calls.length).to.equal(2);
    });

    it('creates separate groups for different tables', async () => {
        const buffer = new UpdateBuffer();

        buffer.add('table_a', {val: 'x'}, {str: 'id = $1', values: [1]}, ['id']);
        buffer.add('table_b', {val: 'y'}, {str: 'id = $1', values: [1]}, ['id']);

        const calls: any[] = [];
        const fakeTx = {
            updateBatch: async (...args: any[]) => { calls.push(args); }
        } as any;

        await buffer.flush(fakeTx);

        expect(calls.length).to.equal(2);
        const tables = calls.map(c => c[0]).sort();
        expect(tables).to.deep.equal(['table_a', 'table_b']);
    });

    it('flush on empty buffer is a no-op (early return)', async () => {
        const buffer = new UpdateBuffer();
        const calls: any[] = [];
        const fakeTx = {
            updateBatch: async (...args: any[]) => { calls.push(args); }
        } as any;

        await buffer.flush(fakeTx);

        expect(calls.length).to.equal(0);
    });

    it('chunks large groups into batches of 500', async () => {
        const buffer = new UpdateBuffer();

        for (let i = 0; i < 600; i++) {
            buffer.add('t', {val: i}, {str: 'id = $1', values: [i]}, ['id']);
        }

        expect(buffer.totalRows).to.equal(600);

        const calls: any[] = [];
        const fakeTx = {
            updateBatch: async (...args: any[]) => { calls.push(args); }
        } as any;

        await buffer.flush(fakeTx);

        expect(calls.length).to.equal(2);
        expect(calls[0][3].length).to.equal(500);
        expect(calls[1][3].length).to.equal(100);
    });

    it('sorts setColumns for consistent grouping', async () => {
        const buffer = new UpdateBuffer();

        // First add sets {b, a} - stored with sorted keys: [a, b]
        buffer.add('t', {b: 2, a: 1}, {str: 'id = $1', values: [1]}, ['id']);
        // Second add sets {a, b} - same sorted keys
        buffer.add('t', {a: 3, b: 4}, {str: 'id = $1', values: [2]}, ['id']);

        const calls: any[] = [];
        const fakeTx = {
            updateBatch: async (...args: any[]) => { calls.push(args); }
        } as any;

        await buffer.flush(fakeTx);

        // Should be grouped together since sorted setColumns match
        expect(calls.length).to.equal(1);
        expect(calls[0][3].length).to.equal(2);
    });

    it('preserves existing fields when merging updates with different keys', async () => {
        const buffer = new UpdateBuffer();

        buffer.add('t', {a: 1, b: 2}, {str: 'id = $1', values: [1]}, ['id']);
        buffer.add('t', {c: 3}, {str: 'id = $1', values: [1]}, ['id']);

        // After merge, the row should have a, b, and c
        expect(buffer.totalRows).to.equal(1);

        const calls: any[] = [];
        const fakeTx = {
            updateBatch: async (...args: any[]) => { calls.push(args); }
        } as any;

        await buffer.flush(fakeTx);

        expect(calls.length).to.equal(1);
        const row = calls[0][3][0];
        expect(row.setValues).to.deep.equal({a: 1, b: 2, c: 3});
    });

    it('passes lock parameter through to updateBatch', async () => {
        const buffer = new UpdateBuffer();
        buffer.add('t', {val: 'a'}, {str: 'id = $1', values: [1]}, ['id']);

        const calls: any[] = [];
        const fakeTx = {
            updateBatch: async (...args: any[]) => { calls.push(args); }
        } as any;

        await buffer.flush(fakeTx, true);
        expect(calls[0][4]).to.equal(true);

        // Test with lock=false
        buffer.add('t', {val: 'b'}, {str: 'id = $1', values: [3]}, ['id']);
        await buffer.flush(fakeTx, false);
        expect(calls[1][4]).to.equal(false);
    });
});

describe('WriteBuffer unit tests', () => {
    it('tracks totalRows across batches', () => {
        const buffer = new WriteBuffer();

        buffer.add('table_a', {id: 1, val: 'a'}, ['id'], 'update', false);
        buffer.add('table_a', {id: 2, val: 'b'}, ['id'], 'update', false);
        buffer.add('table_b', {id: 1, name: 'x'}, ['id'], 'nothing', false);

        expect(buffer.totalRows).to.equal(3);
    });

    it('groups rows by table + onConflict + primaryKey + columns', () => {
        const buffer = new WriteBuffer();

        // Same table, same conflict, same pk, same columns → same batch
        buffer.add('t', {id: 1, a: 1}, ['id'], 'update', false);
        buffer.add('t', {id: 2, a: 2}, ['id'], 'update', false);
        expect(buffer.totalRows).to.equal(2);

        // Different onConflict → separate batch
        buffer.add('t', {id: 3, a: 3}, ['id'], 'nothing', false);
        expect(buffer.totalRows).to.equal(3);
    });

    it('handles array values in add()', () => {
        const buffer = new WriteBuffer();

        buffer.add('t', [{id: 1}, {id: 2}, {id: 3}], ['id'], 'update', false);
        expect(buffer.totalRows).to.equal(3);
    });

    it('clear() empties all batches', () => {
        const buffer = new WriteBuffer();

        buffer.add('t', {id: 1}, ['id'], 'update', false);
        buffer.add('t', {id: 2}, ['id'], 'update', false);
        expect(buffer.totalRows).to.equal(2);

        buffer.clear();
        expect(buffer.totalRows).to.equal(0);
    });

    it('ignores empty array values', () => {
        const buffer = new WriteBuffer();

        buffer.add('t', [], ['id'], 'update', false);
        expect(buffer.totalRows).to.equal(0);
    });

    it('normalizes key order so same columns batch together', () => {
        const buffer = new WriteBuffer();

        buffer.add('t', {id: 1, b: 2, a: 1}, ['id'], 'update', false);
        buffer.add('t', {id: 2, a: 3, b: 4}, ['id'], 'update', false);

        // Same columns, different order → single batch with normalized keys
        expect(buffer.totalRows).to.equal(2);
    });

    it('separates batches with different column sets', () => {
        const buffer = new WriteBuffer();

        buffer.add('t', {id: 1, a: 1}, ['id'], 'update', false);
        buffer.add('t', {id: 2, b: 2}, ['id'], 'update', false);

        // Different columns → separate batches, total is still 2
        expect(buffer.totalRows).to.equal(2);
    });

    it('accepts onConflict error', () => {
        const buffer = new WriteBuffer();

        buffer.add('t', {id: 1, val: 'a'}, ['id'], 'error', false);
        expect(buffer.totalRows).to.equal(1);
    });

    it('separates batches by updateBlacklist', () => {
        const buffer = new WriteBuffer();

        buffer.add('t', {id: 1, a: 1, b: 2}, ['id'], 'update', false, ['a']);
        buffer.add('t', {id: 2, a: 3, b: 4}, ['id'], 'update', false, ['b']);

        // Different blacklists → separate batches
        expect(buffer.totalRows).to.equal(2);
    });

    it('deduplicates by PK within upsert batch (last-write-wins)', () => {
        const buffer = new WriteBuffer();

        buffer.add('t', {id: 1, val: 'first'}, ['id'], 'update', false);
        buffer.add('t', {id: 1, val: 'second'}, ['id'], 'update', false);

        // Same PK → deduped to 1 row
        expect(buffer.totalRows).to.equal(1);
    });

    it('deduplicates with composite PK', () => {
        const buffer = new WriteBuffer();

        buffer.add('t', {a: 1, b: 2, val: 'first'}, ['a', 'b'], 'update', false);
        buffer.add('t', {a: 1, b: 2, val: 'second'}, ['a', 'b'], 'update', false);
        buffer.add('t', {a: 1, b: 3, val: 'third'}, ['a', 'b'], 'update', false);

        // (1,2) deduped → 2 rows total
        expect(buffer.totalRows).to.equal(2);
    });

    it('does not deduplicate for onConflict error', () => {
        const buffer = new WriteBuffer();

        buffer.add('t', {id: 1, val: 'first'}, ['id'], 'error', false);
        buffer.add('t', {id: 1, val: 'second'}, ['id'], 'error', false);

        // No dedup for error mode - both rows kept
        expect(buffer.totalRows).to.equal(2);
    });

    it('deduplicates within array input', () => {
        const buffer = new WriteBuffer();

        buffer.add('t', [
            {id: 1, val: 'first'},
            {id: 1, val: 'second'},
            {id: 2, val: 'third'},
        ], ['id'], 'update', false);

        // id=1 deduped → 2 rows
        expect(buffer.totalRows).to.equal(2);
    });

    it('deduplicates for onConflict nothing (same as update)', () => {
        const buffer = new WriteBuffer();

        buffer.add('t', {id: 1, val: 'first'}, ['id'], 'nothing', false);
        buffer.add('t', {id: 1, val: 'second'}, ['id'], 'nothing', false);

        expect(buffer.totalRows).to.equal(1);
    });

    it('last-write-wins preserves the final value after dedup', async () => {
        const buffer = new WriteBuffer();

        buffer.add('t', {id: 1, val: 'first'}, ['id'], 'update', false);
        buffer.add('t', {id: 1, val: 'second'}, ['id'], 'update', false);
        buffer.add('t', {id: 1, val: 'third'}, ['id'], 'update', false);

        const calls: any[] = [];
        const fakeTx = {
            insertDirect: async (...args: any[]) => { calls.push(args); }
        } as any;

        await buffer.flush(fakeTx, false);

        expect(calls.length).to.equal(1);
        expect(calls[0][1].length).to.equal(1);
        expect(calls[0][1][0].val).to.equal('third');
    });

    it('does not deduplicate with empty primaryKey', () => {
        const buffer = new WriteBuffer();

        buffer.add('t', {val: 'a'}, [], 'update', false);
        buffer.add('t', {val: 'a'}, [], 'update', false);

        // No PK → no dedup → 2 rows
        expect(buffer.totalRows).to.equal(2);
    });

    it('dedup uses string coercion for PK values', () => {
        const buffer = new WriteBuffer();

        // numeric 1 and string '1' should collide since PK hash uses String()
        buffer.add('t', {id: 1, val: 'first'}, ['id'], 'update', false);
        buffer.add('t', {id: '1', val: 'second'}, ['id'], 'update', false);

        expect(buffer.totalRows).to.equal(1);
    });

    it('composite PK dedup requires all parts to match', () => {
        const buffer = new WriteBuffer();

        buffer.add('t', {a: 1, b: 1, val: 'x'}, ['a', 'b'], 'update', false);
        buffer.add('t', {a: 1, b: 2, val: 'y'}, ['a', 'b'], 'update', false);
        buffer.add('t', {a: 2, b: 1, val: 'z'}, ['a', 'b'], 'update', false);

        // All different PKs → 3 rows
        expect(buffer.totalRows).to.equal(3);
    });

    it('normalizes row values to sorted key order', async () => {
        const buffer = new WriteBuffer();

        // Add rows with different key orders - should be normalized
        buffer.add('t', {id: 1, b: 'b1', a: 'a1'}, ['id'], 'update', false);
        buffer.add('t', {a: 'a2', id: 2, b: 'b2'}, ['id'], 'update', false);

        const calls: any[] = [];
        const fakeTx = {
            insertDirect: async (...args: any[]) => { calls.push(args); }
        } as any;

        await buffer.flush(fakeTx, false);

        // Both rows should have the same key order: a, b, id (sorted)
        const rows = calls[0][1];
        expect(Object.keys(rows[0])).to.deep.equal(['a', 'b', 'id']);
        expect(Object.keys(rows[1])).to.deep.equal(['a', 'b', 'id']);
    });

    it('handles null values in rows', () => {
        const buffer = new WriteBuffer();

        buffer.add('t', {id: 1, val: null}, ['id'], 'update', false);
        expect(buffer.totalRows).to.equal(1);
    });

    it('handles undefined values in rows', () => {
        const buffer = new WriteBuffer();

        buffer.add('t', {id: 1, val: undefined}, ['id'], 'update', false);
        expect(buffer.totalRows).to.equal(1);
    });
});

describe('UpdateBuffer unit tests', () => {
    it('tracks totalRows', () => {
        const buffer = new UpdateBuffer();

        buffer.add('t', {val: 'a'}, {str: 'id = $1', values: [1]}, ['id']);
        buffer.add('t', {val: 'b'}, {str: 'id = $1', values: [2]}, ['id']);

        expect(buffer.totalRows).to.equal(2);
    });

    it('merges updates to the same row (last-write-wins)', () => {
        const buffer = new UpdateBuffer();

        buffer.add('t', {val: 'first', extra: 1}, {str: 'id = $1', values: [1]}, ['id']);
        buffer.add('t', {val: 'second'}, {str: 'id = $1', values: [1]}, ['id']);

        // Same row → merged, still 1
        expect(buffer.totalRows).to.equal(1);
    });

    it('filters PK columns from set values', () => {
        const buffer = new UpdateBuffer();

        // values include PK column 'id' - should be filtered out
        buffer.add('t', {id: 1, val: 'a'}, {str: 'id = $1', values: [1]}, ['id']);

        expect(buffer.totalRows).to.equal(1);
    });

    it('handles composite PKs', () => {
        const buffer = new UpdateBuffer();

        buffer.add('t', {val: 'a'}, {str: 'a = $1 AND b = $2', values: [1, 2]}, ['a', 'b']);
        buffer.add('t', {val: 'b'}, {str: 'a = $1 AND b = $2', values: [1, 3]}, ['a', 'b']);

        // Different PKs → 2 rows
        expect(buffer.totalRows).to.equal(2);
    });

    it('clear() empties all pending', () => {
        const buffer = new UpdateBuffer();

        buffer.add('t', {val: 'a'}, {str: 'id = $1', values: [1]}, ['id']);
        buffer.add('t', {val: 'b'}, {str: 'id = $1', values: [2]}, ['id']);
        expect(buffer.totalRows).to.equal(2);

        buffer.clear();
        expect(buffer.totalRows).to.equal(0);
    });

    it('separates rows by table', () => {
        const buffer = new UpdateBuffer();

        buffer.add('table_a', {val: 'a'}, {str: 'id = $1', values: [1]}, ['id']);
        buffer.add('table_b', {val: 'b'}, {str: 'id = $1', values: [1]}, ['id']);

        // Different tables, same PK value → 2 separate entries
        expect(buffer.totalRows).to.equal(2);
    });

    it('stores PK values from condition, not from values object', () => {
        const buffer = new UpdateBuffer();

        // The condition.values should be the source of truth for PK values
        buffer.add('t', {id: 999, val: 'a'}, {str: 'id = $1', values: [42]}, ['id']);

        expect(buffer.totalRows).to.equal(1);
    });

    it('handles all values being PK columns (empty setValues)', () => {
        const buffer = new UpdateBuffer();

        buffer.add('t', {id: 1}, {str: 'id = $1', values: [1]}, ['id']);

        // Entry is added but setValues is empty
        expect(buffer.totalRows).to.equal(1);
    });

    it('merging overwrites individual fields (not entire object)', async () => {
        const buffer = new UpdateBuffer();

        buffer.add('t', {a: 1, b: 2}, {str: 'id = $1', values: [1]}, ['id']);
        buffer.add('t', {a: 10}, {str: 'id = $1', values: [1]}, ['id']);

        // After merge: a should be 10, b should still be 2
        expect(buffer.totalRows).to.equal(1);

        const calls: any[] = [];
        const fakeTx = {
            updateBatch: async (...args: any[]) => { calls.push(args); }
        } as any;

        await buffer.flush(fakeTx);

        const row = calls[0][3][0];
        expect(row.setValues.a).to.equal(10);
        expect(row.setValues.b).to.equal(2);
    });

    it('uses null separator in PK hash for composite keys', () => {
        const buffer = new UpdateBuffer();

        // These should be different rows because the PK hash is "a\0b" vs "a\0c"
        buffer.add('t', {val: 'x'}, {str: 'k1 = $1 AND k2 = $2', values: ['a', 'b']}, ['k1', 'k2']);
        buffer.add('t', {val: 'y'}, {str: 'k1 = $1 AND k2 = $2', values: ['a', 'c']}, ['k1', 'k2']);

        expect(buffer.totalRows).to.equal(2);
    });
});

describe('isPkCondition', () => {
    it('matches simple unquoted PK condition', () => {
        expect(isPkCondition(
            {str: 'contract = $1 AND asset_id = $2', values: ['atomicassets', '123']},
            ['contract', 'asset_id']
        )).to.be.true;
    });

    it('matches quoted PK condition', () => {
        expect(isPkCondition(
            {str: '"contract" = $1 AND "asset_id" = $2', values: ['atomicassets', '123']},
            ['contract', 'asset_id']
        )).to.be.true;
    });

    it('rejects condition with ANY operator', () => {
        expect(isPkCondition(
            {str: 'contract = $1 AND asset_id = ANY ($2) AND owner = $3', values: ['a', [1,2], 'b']},
            ['contract', 'asset_id']
        )).to.be.false;
    });

    it('rejects condition with extra clauses', () => {
        expect(isPkCondition(
            {str: 'contract = $1 AND asset_id = $2 AND state = $3', values: ['a', 1, 2]},
            ['contract', 'asset_id']
        )).to.be.false;
    });

    it('rejects condition with mismatched value count', () => {
        expect(isPkCondition(
            {str: 'contract = $1 AND asset_id = $2', values: ['atomicassets']},
            ['contract', 'asset_id']
        )).to.be.false;
    });

    it('matches single-column PK', () => {
        expect(isPkCondition(
            {str: 'id = $1', values: [42]},
            ['id']
        )).to.be.true;
    });

    it('rejects empty primaryKey with non-empty condition', () => {
        expect(isPkCondition(
            {str: 'id = $1', values: [42]},
            []
        )).to.be.false;
    });

    it('matches empty primaryKey with empty condition', () => {
        expect(isPkCondition(
            {str: '', values: []},
            []
        )).to.be.true;
    });

    it('rejects when column names differ', () => {
        expect(isPkCondition(
            {str: 'wrong_col = $1', values: [42]},
            ['id']
        )).to.be.false;
    });

    it('rejects condition with OR instead of AND', () => {
        expect(isPkCondition(
            {str: 'a = $1 OR b = $2', values: [1, 2]},
            ['a', 'b']
        )).to.be.false;
    });

    it('rejects condition with parameter offset (e.g. $3 instead of $1)', () => {
        expect(isPkCondition(
            {str: 'id = $3', values: [42]},
            ['id']
        )).to.be.false;
    });

    it('rejects when too many values for single-column PK', () => {
        expect(isPkCondition(
            {str: 'id = $1', values: [42, 99]},
            ['id']
        )).to.be.false;
    });
});
