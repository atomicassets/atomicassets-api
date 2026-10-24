import 'mocha';
import {expect} from 'chai';
import * as sinon from 'sinon';
import ListPoller from './list-poller';
import type PostgresConnection from '../connections/postgres';

describe('list ID cache', () => {
    let sequence = 0;
    let clock: sinon.SinonFakeTimers;

    beforeEach(() => {
        clock = sinon.useFakeTimers();
    });

    afterEach(() => {
        clock.restore();
    });

    function setup() {
        const name = `poller-cache-${++sequence}`;
        const select = sinon.stub().resolves(null);
        const insert = sinon.stub().resolves({id: 42});
        const update = sinon.stub().resolves({updated_count: 0});
        const fetchOne = sinon.stub().callsFake((sql: string, values: unknown[]) => {
            if (sql.startsWith('SELECT id')) return select(sql, values);
            if (sql.startsWith('INSERT INTO lists')) return insert(sql, values);
            return update(sql, values);
        });
        const createPoller = () => new ListPoller({url: 'https://example.invalid'}, {fetchOne} as unknown as PostgresConnection);
        const sync = (listName = name, poller = createPoller()) => (poller as unknown as {
            syncListWithDb(list: {listName: string; items: {itemName: string}[]}): Promise<void>;
        }).syncListWithDb({listName, items: [{itemName: 'alice'}]});
        return {name, select, insert, update, createPoller, sync};
    }

    it('shares pending ID lookups across pollers, including an insert on a missing list', async () => {
        const {sync, select, insert, update} = setup();
        let resolve: (value: null) => void;
        select.returns(new Promise(done => { resolve = done; }));
        const first = sync();
        const second = sync();
        expect(select.callCount).to.equal(1);
        resolve(null);
        await Promise.all([first, second]);
        expect(insert.callCount).to.equal(1);
        expect(update.callCount).to.equal(2);
        expect(update.firstCall.args[1]).to.deep.equal([42, ['alice']]);
    });

    it('keeps multiple IDs indefinitely and ignores the database argument', async () => {
        const {name, sync, select, insert, createPoller} = setup();
        select.resolves({id: 7});
        await sync();
        await sync(`${name}-other`);
        await clock.tickAsync(2 * 24 * 60 * 60 * 1000);
        // A separate poller (and database object) must use the same module-level cache.
        await sync(name, createPoller());
        expect(select.callCount).to.equal(2);
        expect(insert.called).to.be.false;
    });

    it('retries a rejected lookup instead of caching the error', async () => {
        const {sync, select} = setup();
        const error = new Error('lookup failed');
        select.rejects(error);
        const results = await Promise.allSettled([sync(), sync()]);
        expect(results).to.deep.equal([
            {status: 'rejected', reason: error},
            {status: 'rejected', reason: error},
        ]);
        expect(select.callCount).to.equal(1);
        select.resolves({id: 7});
        await sync();
        expect(select.callCount).to.equal(2);
    });

    it('retries a failed insert', async () => {
        const {sync, select, insert} = setup();
        insert.rejects(new Error('insert failed'));
        await expect(sync()).to.be.rejectedWith('insert failed');
        insert.resolves({id: 42});
        await sync();
        expect(select.callCount).to.equal(2);
        expect(insert.callCount).to.equal(2);
    });
});
