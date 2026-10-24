import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import ConnectionManager from '../connections/manager';
import { ContractDB, __resetColumnMetaCache } from './database';
import { connectionConfig, getTestPostgresConfig } from '../utils/test';

describe('database tests', () => {
    let connection: ConnectionManager;
    let contract: ContractDB;

    beforeAll(() => {
        connection = new ConnectionManager({...connectionConfig, postgres: getTestPostgresConfig()});
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

    afterAll(async () => {
        await connection.redis.disconnect();
        await connection.database.pool.end();
    });
});
