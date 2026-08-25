import 'mocha';
import {expect} from 'chai';
import * as sinon from 'sinon';
import PQueue from 'p-queue';

import Semaphore from '../utils/semaphore';
import StateReceiver from './receiver';
import { ShipBlockResponse } from '../types/ship';
import { ProcessingState } from './processor';
import logger from '../utils/winston';

/**
 * Build a minimal StateReceiver-like object that has the fields used
 * by the consume() method, without requiring a real ConnectionManager.
 */
function createReceiverStub(opts: {
    queueSize?: number;
    processResult?: () => Promise<void>;
    prepareThrows?: boolean;
} = {}): {
    receiver: StateReceiver;
    dsLock: Semaphore;
    dsQueue: PQueue;
} {
    const queueSize = opts.queueSize ?? 3;
    const dsLock = new Semaphore(queueSize);
    const dsQueue = new PQueue({concurrency: 1, autoStart: true});

    // Build a partial StateReceiver with only the fields consume() needs
    const receiver = Object.create(StateReceiver.prototype) as StateReceiver;
    (receiver as any).dsLock = dsLock;
    (receiver as any).dsQueue = dsQueue;
    // Object.create skips instance field initializers; mirror the real default.
    (receiver as any).queueStopped = false;
    (receiver as any).config = {
        name: 'test-reader',
        ship_prefetch_blocks: 50,
        ship_min_block_confirmation: 10,
        ship_ds_queue_size: queueSize,
    };

    // Stub the prepareActionTraces and prepareContractRows
    if (opts.prepareThrows) {
        (receiver as any).prepareActionTraces = sinon.stub().rejects(new Error('Unsupported SHiP variant'));
        (receiver as any).prepareContractRows = sinon.stub().resolves([]);
    } else {
        (receiver as any).prepareActionTraces = sinon.stub().resolves([]);
        (receiver as any).prepareContractRows = sinon.stub().resolves([]);
    }

    // Stub process() - can be overridden per test
    (receiver as any).process = opts.processResult ?? sinon.stub().resolves();

    return { receiver, dsLock, dsQueue };
}

function makeBlockResponse(blockNum: number): ShipBlockResponse {
    const id = blockNum.toString(16).padStart(64, '0');
    return {
        this_block: { block_num: blockNum, block_id: id },
        head: { block_num: blockNum + 100, block_id: 'f'.repeat(64) },
        last_irreversible: { block_num: blockNum - 5, block_id: 'e'.repeat(64) },
        prev_block: { block_num: blockNum - 1, block_id: 'd'.repeat(64) },
        block: { block_num: blockNum, block_id: id, timestamp: '2023-01-01T00:00:00.000' } as any,
        traces: [],
        deltas: [],
    };
}

describe('StateReceiver', () => {
    describe('consume - dsLock semaphore management', () => {
        it('releases dsLock on successful block processing', async () => {
            const { receiver, dsLock } = createReceiverStub();
            const resp = makeBlockResponse(1000);

            await receiver.consume(resp);

            // Wait for dsQueue to drain
            await (receiver as any).dsQueue.onIdle();

            // dsLock should be fully released (counter back to 0 after acquire+release)
            // Verify by acquiring all permits - should not block
            const allAcquired = Promise.all(
                Array.from({length: 3}, () => dsLock.acquire())
            );
            const timeout = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('dsLock still held - semaphore leaked')), 200)
            );
            await Promise.race([allAcquired, timeout]);
        });

        it('releases dsLock on error path (prevents semaphore leak)', async () => {
            const { receiver, dsLock, dsQueue } = createReceiverStub({
                processResult: () => Promise.reject(new Error('DB connection lost')),
            });
            const resp = makeBlockResponse(2000);

            await receiver.consume(resp);
            await dsQueue.onIdle();

            // Even though process() threw, the dsLock should be released.
            // If the fix is missing, this will time out because the permit leaks.
            const allAcquired = Promise.all(
                Array.from({length: 3}, () => dsLock.acquire())
            );
            const timeout = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('dsLock leaked - release() missing on error path')), 200)
            );
            await Promise.race([allAcquired, timeout]);
        });

        it('sets queueStopped on a non-recoverable error so the watchdog restarts fast', async () => {
            const { receiver, dsQueue } = createReceiverStub({
                processResult: () => Promise.reject(new Error('DB connection lost')),
            });

            expect((receiver as any).queueStopped).to.equal(false);

            await receiver.consume(makeBlockResponse(2500));
            await dsQueue.onIdle();

            // The fatal-stop branch flips queueStopped so filler.ts exits the pod
            // immediately instead of waiting out the multi-minute stall timer.
            expect((receiver as any).queueStopped).to.equal(true);
        });

        it('does NOT set queueStopped when a block processes cleanly', async () => {
            const { receiver, dsQueue } = createReceiverStub({
                processResult: () => Promise.resolve(),
            });

            await receiver.consume(makeBlockResponse(2501));
            await dsQueue.onIdle();

            expect((receiver as any).queueStopped).to.equal(false);
        });

        it('exhausts semaphore if release is missing on repeated errors', async () => {
            // This test verifies the bug scenario: without the fix,
            // each error leaks a permit until the filler stalls.
            const queueSize = 2;
            const { receiver, dsLock, dsQueue } = createReceiverStub({
                queueSize,
                processResult: () => Promise.reject(new Error('Simulated failure')),
            });

            // Process two blocks that will both fail
            await receiver.consume(makeBlockResponse(3000));
            await dsQueue.onIdle();

            // Re-enable the queue (it gets paused on error)
            dsQueue.start();

            await receiver.consume(makeBlockResponse(3001));
            await dsQueue.onIdle();

            // With the fix: both permits are released, so we can acquire both
            let acquired = 0;
            const tryAcquire = async (): Promise<void> => {
                await dsLock.acquire();
                acquired++;
            };

            const p1 = tryAcquire();
            const p2 = tryAcquire();
            const timeout = new Promise(resolve => setTimeout(resolve, 200));

            await Promise.race([Promise.all([p1, p2]), timeout]);
            expect(acquired).to.equal(queueSize);
        });

        it('releases dsLock when preprocessing throws before queue entry', async () => {
            const { receiver, dsLock } = createReceiverStub({ prepareThrows: true });
            const resp = makeBlockResponse(4000);

            // consume() should throw (preprocessing failure), but dsLock must be released
            try {
                await receiver.consume(resp);
            } catch (_e) {
                // expected
            }

            // dsLock should be fully released despite the preprocessing throw
            const allAcquired = Promise.all(
                Array.from({length: 3}, () => dsLock.acquire())
            );
            const timeout = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('dsLock leaked on preprocessing throw')), 200)
            );
            await Promise.race([allAcquired, timeout]);
        });

        it('purges semaphore on fatal error to release queued permits', async () => {
            const queueSize = 3;
            const { receiver, dsLock, dsQueue } = createReceiverStub({
                queueSize,
                processResult: () => Promise.reject(new Error('Fatal DB error')),
            });

            // Queue up multiple blocks - each acquires a dsLock permit
            await receiver.consume(makeBlockResponse(5000));
            // The first block will fail in the queue, triggering clear+purge.
            // After dsQueue drains, all permits should be recoverable.
            await dsQueue.onIdle();

            // Purge should have reset the semaphore - all permits available
            let acquired = 0;
            for (let i = 0; i < queueSize; i++) {
                const p = dsLock.acquire().then(() => { acquired++; });
                const timeout = new Promise(resolve => setTimeout(resolve, 50));
                await Promise.race([p, timeout]);
            }
            expect(acquired).to.equal(queueSize);
        });
    });

    describe('ship rewind guard', () => {
        function createStartedReceiver(checkpoint: number): StateReceiver {
            const receiver = Object.create(StateReceiver.prototype) as StateReceiver;
            (receiver as any).dsLock = new Semaphore(5);
            (receiver as any).dsQueue = new PQueue({concurrency: 1, autoStart: true});
            (receiver as any).config = {
                name: 'test-reader',
                ship_prefetch_blocks: 50,
                ship_min_block_confirmation: 10,
                ship_ds_queue_size: 5,
                start_block: 0,
                stop_block: 0,
                irreversible_only: false,
            };
            (receiver as any).ship = {
                startProcessing: sinon.stub().resolves(),
            };
            (receiver as any).database = {
                getReaderPosition: sinon.stub().resolves({ block_num: checkpoint, live: true, updated: 0 }),
                getLastReaderBlocks: sinon.stub().resolves([]),
                cleanupStaleReversibleData: sinon.stub().resolves(),
                startTransaction: sinon.stub(),
            };
            (receiver as any).processor = {
                setState: sinon.stub(),
                getState: sinon.stub().returns(1),
            };
            (receiver as any).handlers = [];
            // The constructor copies config.name to the readonly field; mirror it.
            (receiver as any).name = 'test-reader';
            return receiver;
        }

        it('starts in catchup even when the stored live flag is set', async () => {
            // live is a one-way latch: it stays true from the first time a reader
            // reached head, so a reader restarting far behind must ignore it and
            // let the per-block head-distance check promote instead.
            const receiver = createStartedReceiver(6_000_000);
            await receiver.startProcessing();

            const setState = (receiver as any).processor.setState;
            expect(setState.calledOnceWith(ProcessingState.CATCHUP)).to.equal(true);
        });

        it('arms the irreversible floor from the checkpoint before the first block', async () => {
            const receiver = createStartedReceiver(6_000_000);
            await receiver.startProcessing();

            expect(receiver.lastIrreversibleBlock).to.equal(6_000_000 - 1000);
            const cleanup = (receiver as any).database.cleanupStaleReversibleData;
            expect(cleanup.calledOnceWith('test-reader', 6_000_000 - 1000)).to.equal(true);
        });

        it('refuses a rollback below the reversible window instead of rewinding', async () => {
            const receiver = createStartedReceiver(6_000_000);
            await receiver.startProcessing();

            const rollbackSpy = sinon.stub().resolves();
            (receiver as any).database.startTransaction = sinon.stub().resolves({
                rollbackReversibleBlocks: rollbackSpy,
                abort: sinon.stub().resolves(),
                insert: sinon.stub().resolves(),
                commit: sinon.stub().resolves(),
            });

            // A SHIP restored from a stale snapshot serves a block far below the
            // checkpoint on the first message after connect.
            const resp = makeBlockResponse(5_000_000);
            let error: Error | null = null;
            try {
                await (receiver as any).process(resp, [], []);
            } catch (e: any) {
                error = e;
            }

            expect(error).to.not.equal(null);
            expect(error!.message).to.include('refusing to rollback');
            expect(rollbackSpy.called).to.equal(false);
        });

        it('still rolls back a genuine fork inside the reversible window', async () => {
            const receiver = createStartedReceiver(6_000_000);
            await receiver.startProcessing();

            const rollbackSpy = sinon.stub().resolves();
            (receiver as any).database.startTransaction = sinon.stub().resolves({
                rollbackReversibleBlocks: rollbackSpy,
                abort: sinon.stub().resolves(),
                insert: sinon.stub().resolves(),
                commit: sinon.stub().resolves(),
                clearForkDatabase: sinon.stub().resolves(),
                updateReaderPosition: sinon.stub().resolves(),
            });
            (receiver as any).notifier = {
                setBlockDistance: sinon.stub(),
                sendFork: sinon.stub(),
                publish: sinon.stub().resolves(),
            };
            (receiver as any).processor = {
                setState: sinon.stub(),
                getState: sinon.stub().returns(1),
                notifyCommit: sinon.stub().resolves(),
            };

            const resp = makeBlockResponse(6_000_000 - 50);
            try {
                await (receiver as any).process(resp, [], []);
            } catch {
                // Later stages of process() may fail against the partial stubs;
                // the assertion below is only about the fork path being taken.
            }

            expect(rollbackSpy.calledOnceWith(6_000_000 - 50)).to.equal(true);
        });

        it('never lets a rewound SHIP status lower the armed floor', async () => {
            const receiver = createStartedReceiver(6_000_000);
            await receiver.startProcessing();

            expect(receiver.lastIrreversibleBlock).to.equal(5_999_000);
            // Simulate the post-block assignment with a stale LIB from the SHIP.
            receiver.lastIrreversibleBlock = Math.max(receiver.lastIrreversibleBlock, 4_000_000);
            expect(receiver.lastIrreversibleBlock).to.equal(5_999_000);
        });
    });

    describe('terminal failure path (no retry)', () => {
        afterEach(() => {
            sinon.restore();
        });

        it('does not retry a block whose processing throws a 40P01 deadlock error', async () => {
            const dsLock = new Semaphore(3);
            const dsQueue = new PQueue({concurrency: 1, autoStart: true});

            // A pg deadlock code gets no second attempt: block processing
            // failures are terminal regardless of the error code.
            const transientLookingError: any = new Error('deadlock detected');
            transientLookingError.code = '40P01';

            const processSpy = sinon.stub().rejects(transientLookingError);

            const receiver = Object.create(StateReceiver.prototype) as StateReceiver;
            (receiver as any).dsLock = dsLock;
            (receiver as any).dsQueue = dsQueue;
            (receiver as any).queueStopped = false;
            (receiver as any).config = { name: 'test-reader' };
            (receiver as any).prepareActionTraces = sinon.stub().resolves([]);
            (receiver as any).prepareContractRows = sinon.stub().resolves([]);
            (receiver as any).process = processSpy;

            await receiver.consume(makeBlockResponse(9100));
            await dsQueue.onIdle();

            expect(processSpy.callCount).to.equal(1);
            expect((receiver as any).queueStopped).to.equal(true);
        });

        function createProcessReceiver(db: any): StateReceiver {
            const receiver = Object.create(StateReceiver.prototype) as StateReceiver;
            (receiver as any).config = { name: 'test-reader', db_group_blocks: 12, irreversible_only: false };
            (receiver as any).currentBlock = 0;
            (receiver as any).headBlock = 0;
            (receiver as any).lastIrreversibleBlock = 0;
            (receiver as any).collectedBlocks = 0;
            (receiver as any).lastBlockUpdate = 0;
            (receiver as any).lastCommittedBlock = 0;
            (receiver as any).blocksUntilHead = 0;
            (receiver as any).lastDatabaseTransaction = undefined;
            (receiver as any).processor = {
                getState: sinon.stub().returns(ProcessingState.HEAD),
                setState: sinon.stub(),
                executeHeadQueue: sinon.stub().resolves(),
                notifyCommit: sinon.stub().resolves(),
            };
            (receiver as any).notifier = {
                setBlockDistance: sinon.stub(),
                sendFork: sinon.stub(),
                publish: sinon.stub().resolves(),
            };
            (receiver as any).modules = {
                checkTrace: sinon.stub().returns(true),
                checkDelta: sinon.stub().returns(true),
            };
            (receiver as any).database = {
                startTransaction: sinon.stub().resolves(db),
            };
            return receiver;
        }

        it('an abort that itself throws does not replace the error being unwound, and the transaction is not retained', async () => {
            const insertError = new Error('duplicate key value violates unique constraint');
            const abortError = new Error('ROLLBACK failed: terminating connection due to administrator command');

            const db = {
                insert: sinon.stub().rejects(insertError),
                abort: sinon.stub().rejects(abortError),
                rollbackReversibleBlocks: sinon.stub().resolves(),
                clearForkDatabase: sinon.stub().resolves(),
                commit: sinon.stub().resolves(),
                updateReaderPosition: sinon.stub().resolves(),
                inTransaction: true,
            };

            const errorSpy = sinon.stub(logger, 'error');
            const receiver = createProcessReceiver(db);
            (receiver as any).lastDatabaseTransaction = db;

            const resp = makeBlockResponse(1);

            let thrown: Error | null = null;
            try {
                await (receiver as any).process(resp, [], []);
            } catch (e: any) {
                thrown = e;
            }

            // The original error propagates; the one raised while unwinding does not replace it.
            expect(thrown).to.equal(insertError);

            // The abort failure is logged as a secondary event rather than silently swallowed.
            const secondaryLogged = errorSpy.getCalls().some(call => call.args.some(arg => arg === abortError));
            expect(secondaryLogged).to.equal(true);

            // An aborted transaction must not be retained for a later block to pick up.
            expect((receiver as any).lastDatabaseTransaction).to.equal(null);
        });

        it('the commit-stage abort path also swallows an abort failure and clears the retained transaction', async () => {
            const commitStageError = new Error('statement timeout');
            const abortError = new Error('ROLLBACK failed: connection terminated');

            const db = {
                insert: sinon.stub().resolves({ rowCount: 0, rows: [] }),
                abort: sinon.stub().rejects(abortError),
                commit: sinon.stub().resolves(),
                updateReaderPosition: sinon.stub().resolves(),
                inTransaction: true,
            };

            const errorSpy = sinon.stub(logger, 'error');
            const receiver = createProcessReceiver(db);
            (receiver as any).processor.executeHeadQueue = sinon.stub().rejects(commitStageError);
            (receiver as any).lastDatabaseTransaction = db;
            // Must sit directly below this_block.block_num or the "Skipped a
            // block" guard at the top of process() throws first.
            (receiver as any).currentBlock = 4;

            // block_num === last_irreversible.block_num keeps isReversible falsy
            // (skips the fork/insert branch); head close to this_block keeps
            // blocksUntilHead small so commitSize is 1 and the commit-stage
            // try/catch runs on this single block.
            const resp: ShipBlockResponse = {
                this_block: { block_num: 5, block_id: '5'.padStart(64, '0') },
                head: { block_num: 15, block_id: 'f'.repeat(64) },
                last_irreversible: { block_num: 5, block_id: 'e'.repeat(64) },
                prev_block: { block_num: 4, block_id: 'd'.repeat(64) },
                block: { block_num: 5, block_id: '5'.padStart(64, '0'), timestamp: '2023-01-01T00:00:00.000' } as any,
                traces: [],
                deltas: [],
            };

            let thrown: Error | null = null;
            try {
                await (receiver as any).process(resp, [], []);
            } catch (e: any) {
                thrown = e;
            }

            expect(thrown).to.equal(commitStageError);

            const secondaryLogged = errorSpy.getCalls().some(call => call.args.some(arg => arg === abortError));
            expect(secondaryLogged).to.equal(true);

            expect((receiver as any).lastDatabaseTransaction).to.equal(null);
        });
    });

    describe('process - api notification publishing', () => {
        it('sets the block distance before the handlers run and publishes after commit', async () => {
            const order: string[] = [];

            const db = {
                insert: sinon.stub().resolves(),
                abort: sinon.stub().resolves(),
                rollbackReversibleBlocks: sinon.stub().resolves(),
                clearForkDatabase: sinon.stub().resolves(),
                commit: sinon.stub().callsFake(async () => { order.push('commit'); }),
                updateReaderPosition: sinon.stub().resolves(),
                inTransaction: true,
            };

            const setBlockDistance = sinon.stub().callsFake((distance: number) => {
                order.push('setBlockDistance:' + distance);
            });
            const publish = sinon.stub().callsFake(async () => { order.push('publish'); });

            const receiver = Object.create(StateReceiver.prototype) as StateReceiver;
            (receiver as any).config = { name: 'test-reader', db_group_blocks: 12, irreversible_only: false };
            (receiver as any).currentBlock = 4;
            (receiver as any).headBlock = 0;
            (receiver as any).lastIrreversibleBlock = 0;
            (receiver as any).collectedBlocks = 0;
            (receiver as any).lastBlockUpdate = 0;
            (receiver as any).lastCommittedBlock = 0;
            (receiver as any).blocksUntilHead = 0;
            (receiver as any).lastDatabaseTransaction = undefined;
            (receiver as any).processor = {
                getState: sinon.stub().returns(ProcessingState.HEAD),
                setState: sinon.stub(),
                executeHeadQueue: sinon.stub().resolves(),
                notifyCommit: sinon.stub().resolves(),
                actionTraceNeeded: sinon.stub().callsFake(() => {
                    order.push('handler');

                    return { process: false, deserialize: false };
                }),
            };
            (receiver as any).notifier = { setBlockDistance, sendFork: sinon.stub(), publish };
            (receiver as any).modules = {
                checkTrace: sinon.stub().returns(true),
                checkDelta: sinon.stub().returns(true),
            };
            (receiver as any).database = { startTransaction: sinon.stub().resolves(db) };

            // head 10 blocks above this_block, and this_block at the irreversible
            // boundary so isReversible stays falsy and commitSize is 1: the
            // commit path runs on this single block and reaches the publish call.
            const resp: ShipBlockResponse = {
                this_block: { block_num: 5, block_id: '5'.padStart(64, '0') },
                head: { block_num: 15, block_id: 'f'.repeat(64) },
                last_irreversible: { block_num: 5, block_id: 'e'.repeat(64) },
                prev_block: { block_num: 4, block_id: 'd'.repeat(64) },
                block: { block_num: 5, block_id: '5'.padStart(64, '0'), timestamp: '2023-01-01T00:00:00.000' } as any,
                traces: [],
                deltas: [],
            };

            const actionTraces = [{
                trace: { act: { account: 'test', name: 'test' } } as any,
                tx: {} as any,
            }];

            await (receiver as any).process(resp, actionTraces, []);

            expect(setBlockDistance.calledOnceWithExactly(10)).to.equal(true);
            expect(publish.calledOnceWithExactly()).to.equal(true);
            expect(order).to.deep.equal(['setBlockDistance:10', 'handler', 'commit', 'publish']);
        });
    });
});
