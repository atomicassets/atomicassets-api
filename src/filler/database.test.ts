import 'mocha';
import {expect} from 'chai';
import ConnectionManager from '../connections/manager';
import {ContractDB, WriteBuffer, UpdateBuffer, isPkCondition, __resetColumnMetaCache} from './database';
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

    // The column-metadata cache is keyed by bare table name and lives for the
    // process; reset it between tests so reused temp-table names never serve
    // stale metadata.
    afterEach(() => __resetColumnMetaCache());

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

        it('raises statement_timeout above the role default after begin', async () => {
            const transaction = await contract.startTransaction(105);

            // begin() issues `SET LOCAL statement_timeout = WRITER_STATEMENT_TIMEOUT_MS`
            // so a large catch-up batch can commit instead of hitting the role's 30s
            // cap (57014). Default is 300000ms; assert it's well above 30s and never 0
            // (0 would DISABLE the timeout - the hang-forever footgun).
            const {rows} = await transaction.query('SHOW statement_timeout', []);
            // pg returns a human string like '5min'; convert via the setting's ms.
            const ms = (await transaction.query(
                "SELECT setting::bigint AS ms FROM pg_settings WHERE name = 'statement_timeout'", []
            )).rows[0].ms;
            expect(Number(ms)).to.be.greaterThan(30000);
            expect(rows[0].statement_timeout).to.not.equal('0');

            await transaction.abort();
        });

        it('begin is idempotent - second call is a no-op', async () => {
            const transaction = await contract.startTransaction(102);

            // Call begin again - should return immediately without error
            await transaction.begin();

            // Session settings from the first begin should still be active
            const {rows} = await transaction.query('SHOW synchronous_commit', []);
            expect(rows[0].synchronous_commit).to.equal('off');

            await transaction.abort();
        });

        it('session settings do not leak across transactions', async () => {
            const transaction = await contract.startTransaction(103);
            await transaction.commit();

            // New raw connection from pool - synchronous_commit should be server default
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

            // Buffer should contain the row - all inserts are buffered in catchup
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

            // Flush and check - block_time should be preserved (100, not 999)
            const result = await transaction.query(
                'SELECT block_time FROM contract_abis WHERE account = \'wb_bl_1\' AND block_num = 10080'
            );
            expect(parseInt(result.rows[0].block_time, 10)).to.equal(100);

            await transaction.abort();
        });
    });

    describe('updateBatch catalog-driven column typing', () => {
        // The cast type for each column comes from the live catalog
        // (pg_attribute), not from guessing at the JS values. An all-null batch
        // column used to be typed `text` and produced unnest($N::text[]) →
        // 42804 against a non-text column (the WAX filler stall, block
        // #438032575). With catalog typing it is cast to the real column type,
        // so writing NULL to a NULLABLE non-text column just works.
        it('stores NULL into a nullable bigint column instead of raising 42804', async () => {
            const transaction = await contract.startTransaction();

            await transaction.query(
                'CREATE TEMP TABLE ub_catalog_nullable (id int PRIMARY KEY, note bigint) ON COMMIT DROP'
            );
            await transaction.query('INSERT INTO ub_catalog_nullable (id, note) VALUES (1, 5), (2, 7)');

            // Every row in the batch sets note = NULL → an all-null column.
            const result = await transaction.updateBatch(
                'ub_catalog_nullable',
                ['id'],
                ['note'],
                [
                    { pkValues: { id: 1 }, setValues: { note: null } },
                    { pkValues: { id: 2 }, setValues: { note: null } },
                ]
            );

            expect(result.rowCount).to.equal(2);
            const check = await transaction.query('SELECT id, note FROM ub_catalog_nullable ORDER BY id');
            expect(check.rows[0].note).to.equal(null);
            expect(check.rows[1].note).to.equal(null);

            await transaction.abort();
        });

        // The real-bug case stays loud - but with an accurate, located message
        // at the writer boundary instead of a misleading 42804 three layers down.
        it('rejects NULL for a NOT NULL column with a clear, located error', async () => {
            const transaction = await contract.startTransaction();

            await transaction.query(
                'CREATE TEMP TABLE ub_catalog_notnull (id int PRIMARY KEY, amount bigint NOT NULL) ON COMMIT DROP'
            );
            await transaction.query('INSERT INTO ub_catalog_notnull (id, amount) VALUES (1, 10)');

            let err: Error | null = null;
            try {
                await transaction.updateBatch(
                    'ub_catalog_notnull',
                    ['id'],
                    ['amount'],
                    [{ pkValues: { id: 1 }, setValues: { amount: null } }]
                );
            } catch (e) {
                err = e as Error;
            }

            expect(err, 'expected updateBatch to throw on NULL into NOT NULL').to.not.equal(null);
            expect(err!.message).to.match(/updateBatch/);
            expect(err!.message).to.match(/NOT NULL/i);
            expect(err!.message).to.include('amount');
            expect(err!.message).to.include('ub_catalog_notnull');

            await transaction.abort();
        });

        // A handler passing a key that is not a real column fails loud at the
        // writer with a clear message, rather than emitting bad SQL.
        it('rejects an unknown column with a clear error naming the column and table', async () => {
            const transaction = await contract.startTransaction();

            await transaction.query(
                'CREATE TEMP TABLE ub_catalog_cols (id int PRIMARY KEY, a bigint) ON COMMIT DROP'
            );
            await transaction.query('INSERT INTO ub_catalog_cols (id, a) VALUES (1, 1)');

            let err: Error | null = null;
            try {
                await transaction.updateBatch(
                    'ub_catalog_cols',
                    ['id'],
                    ['nonexistent'],
                    [{ pkValues: { id: 1 }, setValues: { nonexistent: 5 } }]
                );
            } catch (e) {
                err = e as Error;
            }

            expect(err, 'expected updateBatch to throw on unknown column').to.not.equal(null);
            expect(err!.message).to.match(/updateBatch/);
            expect(err!.message).to.include('nonexistent');
            expect(err!.message).to.include('ub_catalog_cols');

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

            // Non-PK condition - should NOT be buffered
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

            // Flush and verify - last write wins
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

    describe('updateBatch with empty inner array values', () => {
        // PG 42804 regression guard. The catalog reports these columns as
        // jsonb[], so updateBatch routes them through the VALUES-clause path
        // with a per-row $N::jsonb[] cast, which keeps the array structure
        // intact even when one of the rows passes [] for that column. Element
        // values are JSON-encoded scalars because pg-node serializes JS
        // arrays as PG array literals and PG re-parses each element as
        // jsonb (a bare 'x' is not valid JSON; '"x"' is).
        it('updates rows even when one row has an empty inner array value', async () => {
            const transaction = await contract.startTransaction();

            await transaction.query(
                'CREATE TEMP TABLE ub_empty_arr (id int PRIMARY KEY, tags jsonb[] NOT NULL, counts jsonb[] NOT NULL) ON COMMIT DROP'
            );
            await transaction.query(
                'INSERT INTO ub_empty_arr (id, tags, counts) VALUES ' +
                "(1, ARRAY['\"a\"','\"b\"']::jsonb[], ARRAY['1','2']::jsonb[]), " +
                "(2, ARRAY['\"c\"']::jsonb[], ARRAY['3']::jsonb[])"
            );

            // Row 1 clears tags but keeps counts; row 2 keeps tags but clears
            // counts. Two empty-array values across two distinct columns.
            const result = await transaction.updateBatch(
                'ub_empty_arr',
                ['id'],
                ['tags', 'counts'],
                [
                    { pkValues: { id: 1 }, setValues: { tags: [], counts: ['9', '9'] } },
                    { pkValues: { id: 2 }, setValues: { tags: ['"x"'], counts: [] } },
                ]
            );

            expect(result.rowCount).to.equal(2);

            const check = await transaction.query(
                'SELECT id, tags, counts FROM ub_empty_arr ORDER BY id'
            );
            expect(check.rows[0].id).to.equal(1);
            expect(check.rows[0].tags).to.deep.equal([]);
            expect(check.rows[0].counts).to.deep.equal([9, 9]);
            expect(check.rows[1].id).to.equal(2);
            expect(check.rows[1].tags).to.deep.equal(['x']);
            expect(check.rows[1].counts).to.deep.equal([]);

            await transaction.abort();
        });

        // PG 42804 regression guard for non-empty array updates. Before
        // database.ts routed all array columns through the VALUES path,
        // updateBatch emitted $N::T[][] with unnest() which flattened row
        // structure and assigned scalar T to a T[] column. The single known
        // production caller hitting this path is atomicassets_config
        // collection_format updates during catchup-mode irreversible block
        // replay (config.ts:37-43).
        it('handles array columns without empty values (jsonb[] regression)', async () => {
            const transaction = await contract.startTransaction();

            await transaction.query(
                'CREATE TEMP TABLE ub_array_only (id int PRIMARY KEY, tags jsonb[] NOT NULL) ON COMMIT DROP'
            );
            await transaction.query(
                "INSERT INTO ub_array_only (id, tags) VALUES (1, ARRAY['\"a\"']::jsonb[]), (2, ARRAY['\"b\"']::jsonb[])"
            );

            const result = await transaction.updateBatch(
                'ub_array_only',
                ['id'],
                ['tags'],
                [
                    { pkValues: { id: 1 }, setValues: { tags: ['"x"', '"y"'] } },
                    { pkValues: { id: 2 }, setValues: { tags: ['"z"'] } },
                ]
            );

            expect(result.rowCount).to.equal(2);
            const check = await transaction.query(
                'SELECT id, tags FROM ub_array_only ORDER BY id'
            );
            expect(check.rows[0].tags).to.deep.equal(['x', 'y']);
            expect(check.rows[1].tags).to.deep.equal(['z']);

            await transaction.abort();
        });

        // Companion coverage that scalar columns still use the unnest path.
        it('uses the unnest path for scalar columns', async () => {
            const transaction = await contract.startTransaction();

            await transaction.query(
                'CREATE TEMP TABLE ub_unnest_scalar (id int PRIMARY KEY, name text NOT NULL, count bigint NOT NULL) ON COMMIT DROP'
            );
            await transaction.query(
                "INSERT INTO ub_unnest_scalar (id, name, count) VALUES (1, 'a', 10), (2, 'b', 20)"
            );

            const result = await transaction.updateBatch(
                'ub_unnest_scalar',
                ['id'],
                ['name', 'count'],
                [
                    { pkValues: { id: 1 }, setValues: { name: 'updated_a', count: 100 } },
                    { pkValues: { id: 2 }, setValues: { name: 'updated_b', count: 200 } },
                ]
            );

            expect(result.rowCount).to.equal(2);
            const check = await transaction.query(
                'SELECT id, name, count FROM ub_unnest_scalar ORDER BY id'
            );
            expect(check.rows[0].name).to.equal('updated_a');
            expect(check.rows[0].count).to.equal('100');
            expect(check.rows[1].name).to.equal('updated_b');
            expect(check.rows[1].count).to.equal('200');

            await transaction.abort();
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
