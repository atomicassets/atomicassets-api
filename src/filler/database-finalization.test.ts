import 'mocha';
import { expect } from 'chai';
import * as sinon from 'sinon';
import { PoolClient } from 'pg';

import { ContractDB, ContractDBTransaction } from './database';

// No live database here on purpose: database.test.ts wraps its whole suite in
// describe.skip unless POSTGRES_TEST_HOST / config/connections.config.json is
// present, so finalization coverage placed there would silently skip in both
// CI lanes. A fake client whose release() we can count, and whose query()
// never touches a real socket, is all commit()/abort() need to exercise the
// finalization contract.

function createFakeClient(): { client: PoolClient; query: sinon.SinonStub; release: sinon.SinonStub } {
    const query = sinon.stub().resolves({ rows: [], rowCount: 0 });
    const release = sinon.stub();

    const client = {
        query,
        release,
        escapeIdentifier: (name: string) => '"' + name + '"',
    } as unknown as PoolClient;

    return { client, query, release };
}

function makeTransaction(): { tx: ContractDBTransaction; query: sinon.SinonStub; release: sinon.SinonStub } {
    const { client, query, release } = createFakeClient();
    const tx = new ContractDBTransaction(client, 'finalization-test', { operations: 0 });

    return { tx, query, release };
}

describe('ContractDBTransaction finalization', () => {
    // ContractDB.transactions is a static array shared by every instance in
    // the process. begin() pushes onto it, and a normal commit()/abort()
    // removes every occurrence again - but a test that constructs a
    // transaction and never finalizes it (or fails before finalizing) would
    // otherwise leak an entry that later tests would trip over. Snapshot and
    // restore around each test so a failure never bleeds into the next one.
    let transactionsSnapshot: ContractDBTransaction[];

    beforeEach(() => {
        transactionsSnapshot = ContractDB.transactions.slice();
    });

    afterEach(() => {
        ContractDB.transactions.length = 0;
        ContractDB.transactions.push(...transactionsSnapshot);
    });

    it('a committed transaction releases its pg client exactly once', async () => {
        const { tx, release } = makeTransaction();

        await tx.begin();
        await tx.commit();

        expect(release.callCount).to.equal(1);
    });

    it('an aborted transaction releases its pg client exactly once', async () => {
        const { tx, release } = makeTransaction();

        await tx.begin();
        await tx.abort();

        expect(release.callCount).to.equal(1);
    });

    it('abort() after a successful commit() releases nothing further and throws nothing', async () => {
        const { tx, release } = makeTransaction();

        await tx.begin();
        await tx.commit();

        expect(release.callCount).to.equal(1);

        await tx.abort();

        expect(release.callCount).to.equal(1);
    });

    it('abort() called twice releases nothing the second time and throws nothing', async () => {
        const { tx, release } = makeTransaction();

        await tx.begin();
        await tx.abort();

        expect(release.callCount).to.equal(1);

        await tx.abort();

        expect(release.callCount).to.equal(1);
    });

    it('commit() on a finalized transaction flushes no buffers and issues no query', async () => {
        const { tx, query } = makeTransaction();

        await tx.begin();
        await tx.abort();

        const queryCallsAfterAbort = query.callCount;

        // enableWriteBuffer() is normally called by ContractDB.startTransaction()
        // for a block-less (bulk catchup) transaction. Simulate a caller that
        // still holds a reference to this now-finalized instance and queues
        // work against it - the client backing it may already be serving
        // another consumer pulled from the pool.
        tx.enableWriteBuffer();
        tx.writeBuffer!.add('contract_abis', { account: 'x', block_num: 1 }, ['account', 'block_num'], 'error', false);

        await tx.commit();

        expect(query.callCount).to.equal(queryCallsAfterAbort);
        expect(tx.writeBuffer!.totalRows).to.equal(1); // never flushed
    });

    it('a finalized transaction leaves no occurrence of itself in ContractDB.transactions, ' +
        'including when registered repeatedly by a chunked fork rollback', async () => {
        const { tx } = makeTransaction();

        await tx.begin();
        // rollbackReversibleBlocks() clears inTransaction and calls begin()
        // again after each chunked commit, so a fork rollback of N chunks
        // registers the same instance N+1 times. Reproduce that shape here.
        tx.inTransaction = false;
        await tx.begin();
        tx.inTransaction = false;
        await tx.begin();

        expect(ContractDB.transactions.filter(t => t === tx).length).to.equal(3);

        await tx.commit();

        expect(ContractDB.transactions.filter(t => t === tx).length).to.equal(0);
    });

    it('a finalized transaction\'s lock is not held, so a later call on the instance cannot block forever', async () => {
        const { tx } = makeTransaction();

        await tx.begin();
        await tx.commit();

        // A commit() that guarded only the release step (rather than
        // returning before acquiring the lock at all) would acquire the lock
        // here and then skip releasing it, stranding the AwaitLock. That
        // would hang this call rather than resolve it.
        await Promise.race([
            tx.abort(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('lock is stranded')), 500)),
        ]);
    });
});
