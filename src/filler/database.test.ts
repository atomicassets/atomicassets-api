import 'mocha';
import {expect} from 'chai';
import ConnectionManager from '../connections/manager';
import {ContractDB} from './database';
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

    after(async () => {
        await connection.redis.disconnect();
        await connection.database.pool.end();
    });
});
