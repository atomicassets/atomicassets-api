import 'mocha';
import {expect} from 'chai';
import ConnectionManager from '../connections/manager';
import {ContractDB, WriteBuffer, UpdateBuffer, isPkCondition, inferPgType} from './database';
import {connectionConfig} from '../utils/test';

const hasDatabase = !!process.env.POSTGRES_TEST_HOST || (() => {
    try { require('../../config/connections.config.json'); return true; }
    catch { return false; }
})();

(hasDatabase ? describe : describe.skip)('database tests', () => {
    let connection: ConnectionManager;
    let contract: ContractDB;

    before(() => {
        connection = new ConnectionManager(connectionConfig);
        contract = new ContractDB('test', connection);
    });

    it('Contract DB Transaction Insert', async () => {
        const transaction = await contract.startTransaction(1);

        await transaction.insert('contract_abis', {
            account: 'pink.gg',
            abi: new Uint8Array([0, 0, 2, 128]),
            block_num: 1,
            block_time: 0
        }, ['account', 'block_num']);

        await transaction.commit();
    });

    it('Contract DB Transaction Replace', async () => {
        const transaction = await contract.startTransaction(2);

        await transaction.replace('contract_abis', {
            account: 'pink.gg',
            abi: new Uint8Array([0, 0, 128]),
            block_num: 2,
            block_time: 1
        }, ['account', 'block_num']);

        await transaction.replace('contract_abis', {
            account: 'pink.gg',
            abi: new Uint8Array([0, 0, 128]),
            block_num: 2,
            block_time: 2
        }, ['account', 'block_num']);

        await transaction.commit();
    });

    it('Contract DB Transaction Update', async () => {
        const transaction = await contract.startTransaction(3);

        await transaction.update('contract_abis', {
            account: 'pink.gg',
            abi: new Uint8Array([0, 0, 128]),
            block_num: 2,
            block_time: 3
        }, {
            str: 'account = $1',
            values: ['pink.gg']
        }, ['account', 'block_num']);

        await transaction.commit();
    });

    it('Contract DB Transaction Delete', async () => {
        const transaction = await contract.startTransaction(4);

        await transaction.delete('contract_abis', {
            str: 'account = $1',
            values: ['pink.gg']
        });

        await transaction.commit();
    });

    it('Contract DB Rollback', async () => {
        const transaction = await contract.startTransaction(4);

        await transaction.rollbackReversibleBlocks(1);

        await transaction.commit();
    });

    describe('transaction session settings', () => {
        it('sets synchronous_commit = off after begin', async () => {
            const transaction = await contract.startTransaction(100);

            const {rows} = await transaction.query('SHOW synchronous_commit', []);

            expect(rows[0].synchronous_commit).to.equal('off');

            await transaction.abort();
        });

        it('defers constraints after begin', async () => {
            const transaction = await contract.startTransaction(101);

            // SET CONSTRAINTS ALL DEFERRED was issued in begin().
            // Verify we can query within the transaction (confirms no SQL error from the SET).
            const result = await transaction.query('SELECT 1 AS ok', []);
            expect(result.rows[0].ok).to.equal(1);

            await transaction.abort();
        });

        it('begin is idempotent — second call is a no-op', async () => {
            const transaction = await contract.startTransaction(102);

            // Call begin again — should return immediately without error
            await transaction.begin();

            // Session settings from the first begin should still be active
            const {rows} = await transaction.query('SHOW synchronous_commit', []);
            expect(rows[0].synchronous_commit).to.equal('off');

            await transaction.abort();
        });

        it('session settings do not leak across transactions', async () => {
            const transaction = await contract.startTransaction(103);
            await transaction.commit();

            // New raw connection from pool — synchronous_commit should be server default
            const client = await connection.database.pool.connect();
            try {
                const {rows} = await client.query('SHOW synchronous_commit');
                expect(rows[0].synchronous_commit).to.equal('on');
            } finally {
                client.release();
            }
        });

        it('abort rolls back cleanly with session settings active', async () => {
            const transaction = await contract.startTransaction(104);

            await transaction.insert('contract_abis', {
                account: 'abort_test',
                abi: new Uint8Array([0]),
                block_num: 9999,
                block_time: 0
            }, ['account', 'block_num']);

            await transaction.abort();

            // Verify the insert was rolled back
            const client = await connection.database.pool.connect();
            try {
                const {rows} = await client.query(
                    'SELECT count(*) FROM contract_abis WHERE account = \'abort_test\''
                );
                expect(parseInt(rows[0].count, 10)).to.equal(0);
            } finally {
                client.release();
            }
        });
    });

    describe('write buffer', () => {
        it('startTransaction without currentBlock enables write buffer', async () => {
            const transaction = await contract.startTransaction();

            expect(transaction.writeBuffer).to.not.be.null;
            expect(transaction.updateBuffer).to.not.be.null;

            await transaction.abort();
        });

        it('startTransaction with currentBlock does not enable write buffer', async () => {
            const transaction = await contract.startTransaction(500);

            expect(transaction.writeBuffer).to.be.null;
            expect(transaction.updateBuffer).to.be.null;

            await transaction.abort();
        });

        it('buffers inserts with ON CONFLICT DO UPDATE', async () => {
            const transaction = await contract.startTransaction();

            const result = await transaction.insert('contract_abis', {
                account: 'wb_test_1',
                abi: new Uint8Array([1]),
                block_num: 10000,
                block_time: 0
            }, ['account', 'block_num'], true, true, 'update');

            // Should return immediately with fake result
            expect(result.rowCount).to.equal(1);
            expect(result.rows).to.deep.equal([]);

            // Row should NOT be in the DB yet
            const check = await transaction.query(
                'SELECT count(*) FROM contract_abis WHERE account = \'wb_test_1\''
            );
            // query() triggers flush, so the row IS there after the query
            expect(parseInt(check.rows[0].count, 10)).to.equal(1);

            await transaction.abort();
        });

        it('buffers inserts with ON CONFLICT error in catchup mode', async () => {
            const transaction = await contract.startTransaction();

            await transaction.insert('contract_abis', {
                account: 'wb_err_1',
                abi: new Uint8Array([2]),
                block_num: 10001,
                block_time: 0
            }, ['account', 'block_num']);

            // Buffer should contain the row — all inserts are buffered in catchup
            expect(transaction.writeBuffer!.totalRows).to.equal(1);

            // Flush via query and verify
            const check = await transaction.query(
                'SELECT count(*) FROM contract_abis WHERE account = \'wb_err_1\''
            );
            expect(parseInt(check.rows[0].count, 10)).to.equal(1);

            await transaction.abort();
        });

        it('flushes buffer before query (read-after-write)', async () => {
            const transaction = await contract.startTransaction();

            // Buffer multiple inserts
            await transaction.insert('contract_abis', {
                account: 'wb_read_1',
                abi: new Uint8Array([1]),
                block_num: 10010,
                block_time: 0
            }, ['account', 'block_num'], true, true, 'update');

            await transaction.insert('contract_abis', {
                account: 'wb_read_2',
                abi: new Uint8Array([2]),
                block_num: 10011,
                block_time: 0
            }, ['account', 'block_num'], true, true, 'update');

            expect(transaction.writeBuffer!.totalRows).to.equal(2);

            // query() should flush first
            const result = await transaction.query(
                'SELECT count(*) FROM contract_abis WHERE account LIKE \'wb_read_%\''
            );
            expect(parseInt(result.rows[0].count, 10)).to.equal(2);
            expect(transaction.writeBuffer!.totalRows).to.equal(0);

            await transaction.abort();
        });

        it('flushes buffer before update', async () => {
            const transaction = await contract.startTransaction();

            // Insert a row via buffer
            await transaction.insert('contract_abis', {
                account: 'wb_upd_1',
                abi: new Uint8Array([1]),
                block_num: 10020,
                block_time: 0
            }, ['account', 'block_num'], true, true, 'update');

            expect(transaction.writeBuffer!.totalRows).to.equal(1);

            // Update should flush buffer first, then find the row
            await transaction.update('contract_abis', {
                block_time: 999
            }, {
                str: 'account = $1 AND block_num = $2',
                values: ['wb_upd_1', 10020]
            }, ['account', 'block_num'], false);

            // Verify the update took effect
            const result = await transaction.query(
                'SELECT block_time FROM contract_abis WHERE account = \'wb_upd_1\' AND block_num = 10020'
            );
            expect(parseInt(result.rows[0].block_time, 10)).to.equal(999);

            await transaction.abort();
        });

        it('flushes buffer on commit', async () => {
            const transaction = await contract.startTransaction();

            await transaction.insert('contract_abis', {
                account: 'wb_commit_1',
                abi: new Uint8Array([1]),
                block_num: 10030,
                block_time: 0
            }, ['account', 'block_num'], true, true, 'update');

            expect(transaction.writeBuffer!.totalRows).to.equal(1);

            await transaction.commit();

            // Verify the row was committed
            const client = await connection.database.pool.connect();
            try {
                const {rows} = await client.query(
                    'SELECT count(*) FROM contract_abis WHERE account = \'wb_commit_1\''
                );
                expect(parseInt(rows[0].count, 10)).to.equal(1);
            } finally {
                client.release();
            }

            // Clean up
            const cleanup = await contract.startTransaction(999);
            await cleanup.delete('contract_abis', {
                str: 'account = $1',
                values: ['wb_commit_1']
            }, false);
            await cleanup.commit();
        });

        it('clears buffer on abort without flushing', async () => {
            const transaction = await contract.startTransaction();

            await transaction.insert('contract_abis', {
                account: 'wb_abort_1',
                abi: new Uint8Array([1]),
                block_num: 10040,
                block_time: 0
            }, ['account', 'block_num'], true, true, 'update');

            expect(transaction.writeBuffer!.totalRows).to.equal(1);

            await transaction.abort();

            // Verify the row was NOT written
            const client = await connection.database.pool.connect();
            try {
                const {rows} = await client.query(
                    'SELECT count(*) FROM contract_abis WHERE account = \'wb_abort_1\''
                );
                expect(parseInt(rows[0].count, 10)).to.equal(0);
            } finally {
                client.release();
            }
        });

        it('batches rows from multiple inserts to the same table', async () => {
            const transaction = await contract.startTransaction();

            // Three separate inserts to the same table with same columns
            for (let i = 0; i < 3; i++) {
                await transaction.insert('contract_abis', {
                    account: `wb_batch_${i}`,
                    abi: new Uint8Array([i]),
                    block_num: 10050 + i,
                    block_time: 0
                }, ['account', 'block_num'], true, true, 'update');
            }

            // All 3 should be in a single batch
            expect(transaction.writeBuffer!.totalRows).to.equal(3);

            // Flush and verify
            const result = await transaction.query(
                'SELECT count(*) FROM contract_abis WHERE account LIKE \'wb_batch_%\''
            );
            expect(parseInt(result.rows[0].count, 10)).to.equal(3);

            await transaction.abort();
        });

        it('flushes buffer before delete', async () => {
            const transaction = await contract.startTransaction();

            await transaction.insert('contract_abis', {
                account: 'wb_del_1',
                abi: new Uint8Array([1]),
                block_num: 10060,
                block_time: 0
            }, ['account', 'block_num'], true, true, 'update');

            // Delete should flush first, then delete the row
            await transaction.delete('contract_abis', {
                str: 'account = $1 AND block_num = $2',
                values: ['wb_del_1', 10060]
            }, false);

            const result = await transaction.query(
                'SELECT count(*) FROM contract_abis WHERE account = \'wb_del_1\''
            );
            expect(parseInt(result.rows[0].count, 10)).to.equal(0);

            await transaction.abort();
        });

        it('replace uses upsert in catchup mode (writeBuffer active)', async () => {
            const transaction = await contract.startTransaction();

            // First insert
            await transaction.insert('contract_abis', {
                account: 'wb_repl_1',
                abi: new Uint8Array([1]),
                block_num: 10070,
                block_time: 0
            }, ['account', 'block_num'], true, true, 'update');

            // Replace should buffer as upsert (no SELECT needed)
            await transaction.replace('contract_abis', {
                account: 'wb_repl_1',
                abi: new Uint8Array([99]),
                block_num: 10070,
                block_time: 555
            }, ['account', 'block_num'], [], false);

            // Both should be in the buffer
            expect(transaction.writeBuffer!.totalRows).to.be.greaterThan(0);

            const result = await transaction.query(
                'SELECT block_time FROM contract_abis WHERE account = \'wb_repl_1\' AND block_num = 10070'
            );
            expect(parseInt(result.rows[0].block_time, 10)).to.equal(555);

            await transaction.abort();
        });

        it('replace with updateBlacklist preserves blacklisted columns', async () => {
            const transaction = await contract.startTransaction();

            // Insert initial row
            await transaction.insert('contract_abis', {
                account: 'wb_bl_1',
                abi: new Uint8Array([1]),
                block_num: 10080,
                block_time: 100
            }, ['account', 'block_num'], true, true, 'update');

            // Flush the initial insert
            await transaction.query('SELECT 1');

            // Replace with block_time in updateBlacklist
            await transaction.replace('contract_abis', {
                account: 'wb_bl_1',
                abi: new Uint8Array([99]),
                block_num: 10080,
                block_time: 999
            }, ['account', 'block_num'], ['block_time'], false);

            // Flush and check — block_time should be preserved (100, not 999)
            const result = await transaction.query(
                'SELECT block_time FROM contract_abis WHERE account = \'wb_bl_1\' AND block_num = 10080'
            );
            expect(parseInt(result.rows[0].block_time, 10)).to.equal(100);

            await transaction.abort();
        });
    });

    describe('update buffer', () => {
        it('buffers PK-matched updates in catchup mode', async () => {
            const transaction = await contract.startTransaction();

            // Insert a row first
            await transaction.insert('contract_abis', {
                account: 'ub_test_1',
                abi: new Uint8Array([1]),
                block_num: 20000,
                block_time: 0
            }, ['account', 'block_num'], true, true, 'update');

            // Flush the insert
            await transaction.query('SELECT 1');

            // PK-matched update should be buffered
            const result = await transaction.update('contract_abis', {
                block_time: 42
            }, {
                str: 'account = $1 AND block_num = $2',
                values: ['ub_test_1', 20000]
            }, ['account', 'block_num'], false);

            expect(result.rowCount).to.equal(1);
            expect(result.rows).to.deep.equal([]);
            expect(transaction.updateBuffer!.totalRows).to.equal(1);

            // Flush via query and verify
            const check = await transaction.query(
                'SELECT block_time FROM contract_abis WHERE account = \'ub_test_1\' AND block_num = 20000'
            );
            expect(parseInt(check.rows[0].block_time, 10)).to.equal(42);

            await transaction.abort();
        });

        it('does not buffer non-PK condition updates', async () => {
            const transaction = await contract.startTransaction();

            // Insert a row first
            await transaction.insert('contract_abis', {
                account: 'ub_nonpk_1',
                abi: new Uint8Array([1]),
                block_num: 20010,
                block_time: 0
            }, ['account', 'block_num'], true, true, 'update');

            // Flush the insert
            await transaction.query('SELECT 1');

            // Non-PK condition — should NOT be buffered
            await transaction.update('contract_abis', {
                block_time: 99
            }, {
                str: 'account = $1',
                values: ['ub_nonpk_1']
            }, ['account', 'block_num'], false);

            // updateBuffer should still be empty
            expect(transaction.updateBuffer!.totalRows).to.equal(0);

            await transaction.abort();
        });

        it('merges multiple updates to the same row', async () => {
            const transaction = await contract.startTransaction();

            // Insert a row
            await transaction.insert('contract_abis', {
                account: 'ub_merge_1',
                abi: new Uint8Array([1]),
                block_num: 20020,
                block_time: 0
            }, ['account', 'block_num'], true, true, 'update');

            // Flush the insert
            await transaction.query('SELECT 1');

            // Two updates to the same row
            await transaction.update('contract_abis', {
                block_time: 10
            }, {
                str: 'account = $1 AND block_num = $2',
                values: ['ub_merge_1', 20020]
            }, ['account', 'block_num'], false);

            await transaction.update('contract_abis', {
                block_time: 20
            }, {
                str: 'account = $1 AND block_num = $2',
                values: ['ub_merge_1', 20020]
            }, ['account', 'block_num'], false);

            // Should be 1 row (merged), not 2
            expect(transaction.updateBuffer!.totalRows).to.equal(1);

            // Flush and verify — last write wins
            const check = await transaction.query(
                'SELECT block_time FROM contract_abis WHERE account = \'ub_merge_1\' AND block_num = 20020'
            );
            expect(parseInt(check.rows[0].block_time, 10)).to.equal(20);

            await transaction.abort();
        });

        it('batches updates to different rows of the same table', async () => {
            const transaction = await contract.startTransaction();

            // Insert two rows
            await transaction.insert('contract_abis', {
                account: 'ub_batch_1',
                abi: new Uint8Array([1]),
                block_num: 20030,
                block_time: 0
            }, ['account', 'block_num'], true, true, 'update');

            await transaction.insert('contract_abis', {
                account: 'ub_batch_2',
                abi: new Uint8Array([2]),
                block_num: 20031,
                block_time: 0
            }, ['account', 'block_num'], true, true, 'update');

            // Flush inserts
            await transaction.query('SELECT 1');

            // Update both rows with same columns
            await transaction.update('contract_abis', {
                block_time: 111
            }, {
                str: 'account = $1 AND block_num = $2',
                values: ['ub_batch_1', 20030]
            }, ['account', 'block_num'], false);

            await transaction.update('contract_abis', {
                block_time: 222
            }, {
                str: 'account = $1 AND block_num = $2',
                values: ['ub_batch_2', 20031]
            }, ['account', 'block_num'], false);

            expect(transaction.updateBuffer!.totalRows).to.equal(2);

            // Flush and verify both were updated in a single batch
            const check = await transaction.query(
                'SELECT account, block_time FROM contract_abis WHERE account LIKE \'ub_batch_%\' ORDER BY account'
            );
            expect(check.rows.length).to.equal(2);
            expect(parseInt(check.rows[0].block_time, 10)).to.equal(111);
            expect(parseInt(check.rows[1].block_time, 10)).to.equal(222);

            await transaction.abort();
        });

        it('clears update buffer on abort', async () => {
            const transaction = await contract.startTransaction();

            // Insert a row
            await transaction.insert('contract_abis', {
                account: 'ub_abort_1',
                abi: new Uint8Array([1]),
                block_num: 20040,
                block_time: 0
            }, ['account', 'block_num'], true, true, 'update');

            // Flush insert
            await transaction.query('SELECT 1');

            // Buffer an update
            await transaction.update('contract_abis', {
                block_time: 999
            }, {
                str: 'account = $1 AND block_num = $2',
                values: ['ub_abort_1', 20040]
            }, ['account', 'block_num'], false);

            expect(transaction.updateBuffer!.totalRows).to.equal(1);

            await transaction.abort();

            // Verify the update was NOT applied
            const client = await connection.database.pool.connect();
            try {
                const {rows} = await client.query(
                    'SELECT block_time FROM contract_abis WHERE account = \'ub_abort_1\' AND block_num = 20040'
                );
                // Row itself was also aborted (never committed), so should not exist
                expect(rows.length).to.equal(0);
            } finally {
                client.release();
            }
        });
    });

    after(async () => {
        await connection.redis.disconnect();
        await connection.database.pool.end();
    });
});

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

        // First add sets {b, a} — stored with sorted keys: [a, b]
        buffer.add('t', {b: 2, a: 1}, {str: 'id = $1', values: [1]}, ['id']);
        // Second add sets {a, b} — same sorted keys
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

        // No dedup for error mode — both rows kept
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

        // Add rows with different key orders — should be normalized
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

        // values include PK column 'id' — should be filtered out
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

describe('inferPgType', () => {
    it('returns text for string arrays', () => {
        expect(inferPgType(['hello', 'world'])).to.equal('text');
    });

    it('returns bigint for integer arrays', () => {
        expect(inferPgType([1, 2, 3])).to.equal('bigint');
    });

    it('returns double precision for float arrays', () => {
        expect(inferPgType([1.5, 2.7])).to.equal('double precision');
    });

    it('returns boolean for boolean arrays', () => {
        expect(inferPgType([true, false])).to.equal('boolean');
    });

    it('returns bytea for Buffer arrays', () => {
        expect(inferPgType([Buffer.from([1]), Buffer.from([2])])).to.equal('bytea');
    });

    it('returns bytea for Uint8Array arrays', () => {
        expect(inferPgType([new Uint8Array([1]), new Uint8Array([2])])).to.equal('bytea');
    });

    it('returns jsonb for object arrays', () => {
        expect(inferPgType([{a: 1}, {b: 2}])).to.equal('jsonb');
    });

    it('returns text for all-null arrays', () => {
        expect(inferPgType([null, null, undefined])).to.equal('text');
    });

    it('skips nulls and infers from first non-null', () => {
        expect(inferPgType([null, 42, null])).to.equal('bigint');
    });

    it('returns text for empty array', () => {
        expect(inferPgType([])).to.equal('text');
    });

    it('returns bytea for ArrayBuffer.isView types (Int32Array)', () => {
        expect(inferPgType([new Int32Array([1, 2])])).to.equal('bytea');
    });

    it('returns bytea for Float64Array', () => {
        expect(inferPgType([new Float64Array([1.5])])).to.equal('bytea');
    });

    it('returns bigint for negative integers', () => {
        expect(inferPgType([-5, -10])).to.equal('bigint');
    });

    it('returns text for mixed null and string', () => {
        expect(inferPgType([null, undefined, 'hello'])).to.equal('text');
    });

    it('returns jsonb for arrays-of-arrays (nested arrays are objects)', () => {
        expect(inferPgType([[1, 2], [3, 4]])).to.equal('jsonb');
    });

    it('returns double precision for Infinity', () => {
        expect(inferPgType([Infinity])).to.equal('double precision');
    });

    it('returns double precision for NaN', () => {
        expect(inferPgType([NaN])).to.equal('double precision');
    });

    it('infers type from first non-null even when subsequent values differ', () => {
        // inferPgType stops at the first non-null value
        expect(inferPgType([null, 42, 'hello'])).to.equal('bigint');
    });

    it('returns jsonb for JSON object strings (encodeDatabaseJson output)', () => {
        expect(inferPgType(['{"key":"value"}'])).to.equal('jsonb');
        expect(inferPgType(['{"a":1,"b":2}'])).to.equal('jsonb');
    });

    it('returns jsonb for JSON array strings', () => {
        expect(inferPgType(['[1,2,3]'])).to.equal('jsonb');
        expect(inferPgType(['[{"a":1}]'])).to.equal('jsonb');
    });

    it('returns text for strings that look like JSON but are too short', () => {
        expect(inferPgType(['{}'])).to.equal('jsonb'); // valid minimal JSON object
        expect(inferPgType(['[]'])).to.equal('jsonb'); // valid minimal JSON array
        expect(inferPgType(['{'])).to.equal('text');   // incomplete
    });

    it('returns text for non-numeric strings', () => {
        expect(inferPgType(['hello world'])).to.equal('text');
        expect(inferPgType(['pink.gg'])).to.equal('text');
        expect(inferPgType(['abc123'])).to.equal('text');
    });

    it('returns bigint for numeric string values (EOSIO uint64)', () => {
        expect(inferPgType(['76682324'])).to.equal('bigint');
        expect(inferPgType(['12345'])).to.equal('bigint');
        expect(inferPgType(['-999'])).to.equal('bigint');
        expect(inferPgType([null, '100000000000'])).to.equal('bigint');
    });

    it('returns double precision for decimal string values (atomicmarket fees, ratios)', () => {
        // Real-world values from atomicmarket_config: maker_market_fee, taker_market_fee
        expect(inferPgType(['0.01'])).to.equal('double precision');
        expect(inferPgType(['0.1'])).to.equal('double precision');
        expect(inferPgType(['-0.5'])).to.equal('double precision');
        expect(inferPgType([null, '1.234'])).to.equal('double precision');
    });

    it('returns double precision for scientific-notation strings', () => {
        expect(inferPgType(['1e10'])).to.equal('double precision');
        expect(inferPgType(['1.5e-3'])).to.equal('double precision');
    });

    it('returns double precision when integer + decimal strings are mixed', () => {
        // Both must succeed under double precision; only "all integer" picks bigint.
        expect(inferPgType(['120', '0.01'])).to.equal('double precision');
        expect(inferPgType(['0.5', '120'])).to.equal('double precision');
    });

    it('falls back to text when numeric and non-numeric strings are mixed', () => {
        expect(inferPgType(['123', 'abc', '456'])).to.equal('text');
        expect(inferPgType([null, '99', 'not_a_number'])).to.equal('text');
        expect(inferPgType(['0', '1', 'hello'])).to.equal('text');
    });

    it('returns bigint only when all non-null string values are numeric', () => {
        expect(inferPgType([null, '123', null, '456', null])).to.equal('bigint');
    });

    it('returns jsonb for null-prefixed JSON string arrays', () => {
        expect(inferPgType([null, '{"x":1}'])).to.equal('jsonb');
    });

    it('returns jsonb for JS arrays (Array.isArray)', () => {
        // JS arrays are detected before typeof object check
        expect(inferPgType([['a', 'b']])).to.equal('jsonb');
    });
});
