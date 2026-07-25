import 'mocha';
import { expect } from 'chai';
import * as sinon from 'sinon';
import { Client } from 'pg';

import ConnectionManager from '../connections/manager';
import { ContractDB } from './database';
import StateReceiver from './receiver';
import { ProcessingState } from './processor';
import { connectionConfig, getTestPostgresConfig } from '../utils/test';
import { ShipBlockResponse } from '../types/ship';
import logger from '../utils/winston';

// Live-database coverage for block-processing failure recovery: a real
// duplicate-key conflict must leave the reader's on-disk state exactly as
// consistent as before the failed block arrived, with the real pg error (not
// a pool-release failure) reaching the caller. The equivalent unit coverage
// in database-finalization.test.ts and receiver.test.ts uses a fake client to
// pin down the exactly-once finalization contract in isolation; this test
// proves the same recovery path end to end against Postgres.

const READER_NAME = 'transient-recovery-it';

function makeResp(blockNum: number, lastIrreversible: number, headBlock: number): ShipBlockResponse {
    const id = blockNum.toString(16).padStart(64, '0');

    return {
        this_block: { block_num: blockNum, block_id: id },
        head: { block_num: headBlock, block_id: 'f'.repeat(64) },
        last_irreversible: { block_num: lastIrreversible, block_id: 'e'.repeat(64) },
        prev_block: { block_num: blockNum - 1, block_id: 'd'.repeat(64) },
        block: { block_num: blockNum, block_id: id, timestamp: '2023-01-01T00:00:00.000' } as any,
        traces: [],
        deltas: [],
    };
}

describe('filler transient failure recovery (live database)', () => {
    let connection: ConnectionManager;
    let contract: ContractDB;
    let rawClient: Client;

    before(async () => {
        connection = new ConnectionManager({...connectionConfig, postgres: getTestPostgresConfig()});
        contract = new ContractDB(READER_NAME, connection);

        rawClient = new Client(getTestPostgresConfig());
        await rawClient.connect();
    });

    after(async () => {
        await rawClient.end();
        await connection.redis.disconnect();
        await connection.database.pool.end();
    });

    beforeEach(async () => {
        await rawClient.query('DELETE FROM contract_readers WHERE name = $1', [READER_NAME]);
        await rawClient.query('DELETE FROM reversible_blocks WHERE reader = $1', [READER_NAME]);
        await rawClient.query('DELETE FROM reversible_queries WHERE reader = $1', [READER_NAME]);
    });

    it(
        'a duplicate-key conflict inside a block transaction leaves no partial write and no pool-release ' +
        'error, and the checkpoint still names the last committed block',
        async () => {
            const checkpoint = 5_000_000;
            const conflictBlock = checkpoint + 1;

            await rawClient.query(
                'INSERT INTO contract_readers (name, block_num, block_time, live, updated) VALUES ($1, $2, $3, $4, $5)',
                [READER_NAME, checkpoint, 0, false, Date.now()]
            );

            // Pre-seed the row this block is about to insert again - the real
            // shape of a duplicate-key conflict inside process(): the same
            // (reader, block_num) was already recorded, e.g. by a crash that
            // landed between the insert and the checkpoint advance.
            await rawClient.query(
                'INSERT INTO reversible_blocks (reader, block_id, block_num) VALUES ($1, $2, $3)',
                [READER_NAME, Buffer.from(conflictBlock.toString(16).padStart(64, '0'), 'hex'), conflictBlock]
            );

            const receiver = Object.create(StateReceiver.prototype) as StateReceiver;
            (receiver as any).config = { name: READER_NAME, db_group_blocks: 12, irreversible_only: false };
            (receiver as any).database = contract;
            (receiver as any).currentBlock = checkpoint;
            (receiver as any).headBlock = checkpoint;
            (receiver as any).lastIrreversibleBlock = checkpoint - 100;
            (receiver as any).collectedBlocks = 0;
            (receiver as any).lastBlockUpdate = checkpoint;
            (receiver as any).lastCommittedBlock = checkpoint;
            (receiver as any).blocksUntilHead = 0;
            (receiver as any).lastDatabaseTransaction = undefined;
            (receiver as any).processor = {
                getState: () => ProcessingState.HEAD,
                setState: () => undefined,
                executeHeadQueue: async () => undefined,
                notifyCommit: async () => undefined,
            };
            (receiver as any).notifier = {
                sendFork: () => undefined,
                publish: async () => undefined,
            };
            (receiver as any).modules = {
                checkTrace: () => true,
                checkDelta: () => true,
            };

            const errorSpy = sinon.stub(logger, 'error');

            const resp = makeResp(conflictBlock, checkpoint, conflictBlock + 5000);

            let thrown: any = null;
            try {
                await (receiver as any).process(resp, [], []);
            } catch (e) {
                thrown = e;
            } finally {
                errorSpy.restore();
            }

            // The real Postgres duplicate-key error propagates unaltered.
            expect(thrown).to.not.equal(null);
            expect(thrown.code).to.equal('23505');

            // No pool-release error surfaced anywhere in the unwind. A reused
            // or double-released client would throw "Release called on a
            // client which has already been released to the pool" - that
            // would either replace the thrown error above or show up here.
            const releaseErrorLogged = errorSpy.getCalls().some(call =>
                call.args.some(arg => arg && typeof arg.message === 'string' && arg.message.includes('already been released'))
            );
            expect(releaseErrorLogged).to.equal(false);

            // No partial write from the failed block: only the pre-seeded row remains.
            const rows = await rawClient.query(
                'SELECT block_num FROM reversible_blocks WHERE reader = $1 ORDER BY block_num',
                [READER_NAME]
            );
            expect(rows.rows.map(r => Number(r.block_num))).to.deep.equal([conflictBlock]);

            // The durable checkpoint still names the last committed block - a
            // restart replays from a consistent point, not from a block that
            // never actually committed.
            const position = await contract.getReaderPosition();
            expect(position.block_num).to.equal(checkpoint);

            // The aborted transaction is not retained for a later block to pick up.
            expect((receiver as any).lastDatabaseTransaction).to.equal(null);
        }
    );
});
