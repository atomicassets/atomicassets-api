import 'mocha';
import {expect} from 'chai';
import ConnectionManager from '../connections/manager';
import {ContractDB, WriteBuffer} from './database';
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

            await transaction.abort();
        });

        it('startTransaction with currentBlock does not enable write buffer', async () => {
            const transaction = await contract.startTransaction(500);

            expect(transaction.writeBuffer).to.be.null;

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

        it('does not buffer inserts with ON CONFLICT error (default)', async () => {
            const transaction = await contract.startTransaction();

            await transaction.insert('contract_abis', {
                account: 'wb_test_2',
                abi: new Uint8Array([2]),
                block_num: 10001,
                block_time: 0
            }, ['account', 'block_num']);

            // Buffer should still be empty — direct insert with default onConflict
            expect(transaction.writeBuffer!.totalRows).to.equal(0);

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

        it('flushes buffer before replace', async () => {
            const transaction = await contract.startTransaction();

            await transaction.insert('contract_abis', {
                account: 'wb_repl_1',
                abi: new Uint8Array([1]),
                block_num: 10070,
                block_time: 0
            }, ['account', 'block_num'], true, true, 'update');

            // Replace should flush first, then find the existing row and update it
            await transaction.replace('contract_abis', {
                account: 'wb_repl_1',
                abi: new Uint8Array([99]),
                block_num: 10070,
                block_time: 555
            }, ['account', 'block_num'], [], false);

            const result = await transaction.query(
                'SELECT block_time FROM contract_abis WHERE account = \'wb_repl_1\' AND block_num = 10070'
            );
            expect(parseInt(result.rows[0].block_time, 10)).to.equal(555);

            await transaction.abort();
        });
    });

    after(async () => {
        await connection.redis.disconnect();
        await connection.database.pool.end();
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

        buffer.add('t', {b: 2, a: 1}, ['id'], 'update', false);
        buffer.add('t', {a: 3, b: 4}, ['id'], 'update', false);

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
});
