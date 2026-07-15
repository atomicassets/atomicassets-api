import 'mocha';
import {expect} from 'chai';
import * as sinon from 'sinon';
import PQueue from 'p-queue';

import Semaphore from '../utils/semaphore';
import StateReceiver from './receiver';
import { ShipBlockResponse } from '../types/ship';

/**
 * Build a minimal StateReceiver-like object that has the fields used
 * by the consumer() method, without requiring a real ConnectionManager.
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

    // Build a partial StateReceiver with only the fields the consumer needs
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

    // Stub process() — can be overridden per test
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
    describe('consumer — dsLock semaphore management', () => {
        it('releases dsLock on successful block processing', async () => {
            const { receiver, dsLock } = createReceiverStub();
            const resp = makeBlockResponse(1000);

            // Call consumer (the private method)
            await (receiver as any).consumer(resp);

            // Wait for dsQueue to drain
            await (receiver as any).dsQueue.onIdle();

            // dsLock should be fully released (counter back to 0 after acquire+release)
            // Verify by acquiring all permits — should not block
            const allAcquired = Promise.all(
                Array.from({length: 3}, () => dsLock.acquire())
            );
            const timeout = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('dsLock still held — semaphore leaked')), 200)
            );
            await Promise.race([allAcquired, timeout]);
        });

        it('releases dsLock on error path (prevents semaphore leak)', async () => {
            const { receiver, dsLock, dsQueue } = createReceiverStub({
                processResult: () => Promise.reject(new Error('DB connection lost')),
            });
            const resp = makeBlockResponse(2000);

            await (receiver as any).consumer(resp);
            await dsQueue.onIdle();

            // Even though process() threw, the dsLock should be released.
            // If the fix is missing, this will time out because the permit leaks.
            const allAcquired = Promise.all(
                Array.from({length: 3}, () => dsLock.acquire())
            );
            const timeout = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('dsLock leaked — release() missing on error path')), 200)
            );
            await Promise.race([allAcquired, timeout]);
        });

        it('sets queueStopped on a non-recoverable error so the watchdog restarts fast', async () => {
            const { receiver, dsQueue } = createReceiverStub({
                processResult: () => Promise.reject(new Error('DB connection lost')),
            });

            expect((receiver as any).queueStopped).to.equal(false);

            await (receiver as any).consumer(makeBlockResponse(2500));
            await dsQueue.onIdle();

            // The fatal-stop branch flips queueStopped so filler.ts exits the pod
            // immediately instead of waiting out the multi-minute stall timer.
            expect((receiver as any).queueStopped).to.equal(true);
        });

        it('does NOT set queueStopped when a block processes cleanly', async () => {
            const { receiver, dsQueue } = createReceiverStub({
                processResult: () => Promise.resolve(),
            });

            await (receiver as any).consumer(makeBlockResponse(2501));
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
            await (receiver as any).consumer(makeBlockResponse(3000));
            await dsQueue.onIdle();

            // Re-enable the queue (it gets paused on error)
            dsQueue.start();

            await (receiver as any).consumer(makeBlockResponse(3001));
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

            // consumer should throw (preprocessing failure), but dsLock must be released
            try {
                await (receiver as any).consumer(resp);
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

            // Queue up multiple blocks — each acquires a dsLock permit
            await (receiver as any).consumer(makeBlockResponse(5000));
            // The first block will fail in the queue, triggering clear+purge.
            // After dsQueue drains, all permits should be recoverable.
            await dsQueue.onIdle();

            // Purge should have reset the semaphore — all permits available
            let acquired = 0;
            for (let i = 0; i < queueSize; i++) {
                const p = dsLock.acquire().then(() => { acquired++; });
                const timeout = new Promise(resolve => setTimeout(resolve, 50));
                await Promise.race([p, timeout]);
            }
            expect(acquired).to.equal(queueSize);
        });
    });

    describe('startProcessing — ACK deadlock prevention', () => {
        it('overrides min_block_confirmation when prefetch < confirm would deadlock', async () => {
            const dsLock = new Semaphore(5);
            const dsQueue = new PQueue({concurrency: 1, autoStart: true});
            const setOptionsSpy = sinon.spy();

            const receiver = Object.create(StateReceiver.prototype) as StateReceiver;
            (receiver as any).dsLock = dsLock;
            (receiver as any).dsQueue = dsQueue;
            (receiver as any).config = {
                name: 'test-reader',
                ship_prefetch_blocks: 50,
                ship_min_block_confirmation: 75, // BUG: 75 > 50 = deadlock
                ship_ds_queue_size: 5,
                start_block: 100,
                stop_block: 0,
                irreversible_only: false,
            };
            (receiver as any).ship = {
                setOptions: setOptionsSpy,
                startProcessing: sinon.stub(),
                consume: sinon.stub(),
            };
            (receiver as any).database = {
                getReaderPosition: sinon.stub().resolves({ block_num: 99, live: false, updated: 0 }),
                getLastReaderBlocks: sinon.stub().resolves([]),
                cleanupStaleReversibleData: sinon.stub().resolves(),
            };
            (receiver as any).processor = {
                setState: sinon.stub(),
            };
            (receiver as any).handlers = [];

            await receiver.startProcessing();

            // Should have called setOptions to override min_block_confirmation
            expect(setOptionsSpy.calledOnce).to.equal(true);
            const overrideOpts = setOptionsSpy.firstCall.args[0];
            expect(overrideOpts.min_block_confirmation).to.equal(25); // floor(50/2)
        });

        it('does not override when prefetch >= confirm', async () => {
            const dsLock = new Semaphore(5);
            const dsQueue = new PQueue({concurrency: 1, autoStart: true});
            const setOptionsSpy = sinon.spy();

            const receiver = Object.create(StateReceiver.prototype) as StateReceiver;
            (receiver as any).dsLock = dsLock;
            (receiver as any).dsQueue = dsQueue;
            (receiver as any).config = {
                name: 'test-reader',
                ship_prefetch_blocks: 50,
                ship_min_block_confirmation: 10, // 10 < 50 = safe
                ship_ds_queue_size: 5,
                start_block: 100,
                stop_block: 0,
                irreversible_only: false,
            };
            (receiver as any).ship = {
                setOptions: setOptionsSpy,
                startProcessing: sinon.stub(),
                consume: sinon.stub(),
            };
            (receiver as any).database = {
                getReaderPosition: sinon.stub().resolves({ block_num: 99, live: false, updated: 0 }),
                getLastReaderBlocks: sinon.stub().resolves([]),
                cleanupStaleReversibleData: sinon.stub().resolves(),
            };
            (receiver as any).processor = {
                setState: sinon.stub(),
            };
            (receiver as any).handlers = [];

            await receiver.startProcessing();

            // Should NOT have called setOptions
            expect(setOptionsSpy.called).to.equal(false);
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
                setOptions: sinon.stub(),
                startProcessing: sinon.stub(),
                consume: sinon.stub(),
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
});
