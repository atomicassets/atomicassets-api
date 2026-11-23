import 'mocha';
import {expect} from 'chai';
import * as sinon from 'sinon';
import {getSalesCountV2Action} from './sales2';
import {initListValidator} from '../../lists';
import type {AtomicMarketContext} from '../index';
import type {RequestValues} from '../../../utils';

describe('sale count cache', () => {
    let clock: sinon.SinonFakeTimers;
    let sequence = 0;

    beforeEach(() => {
        clock = sinon.useFakeTimers();
        initListValidator({fetchOne: sinon.stub()} as any);
    });

    afterEach(() => {
        clock.restore();
    });

    function setup() {
        const collectionName = `cache${'a'.repeat(++sequence)}`;
        const count = sinon.stub().resolves({rows: [{ct: 10}]});
        const createContext = (market = 'market') => ({
            db: {
                query: (sql: string, values: unknown[]) => sql.includes('COUNT(*)::INT ct')
                    ? count(sql, values)
                    : Promise.resolve({rows: [{counter: 100}]}),
            },
            coreArgs: {atomicmarket_account: market, atomicassets_account: 'assets'},
        } as unknown as AtomicMarketContext);
        const read = (values: RequestValues = {}, ctx = createContext()) => getSalesCountV2Action({
            collection_name: collectionName, state: '1', ...values,
        }, ctx);
        return {collectionName, count, createContext, read};
    }

    it('deduplicates pending probes and ignores the search context argument', async () => {
        const {read, count, createContext} = setup();
        let resolve: (value: {rows: {ct: number}[]}) => void;
        count.returns(new Promise(done => { resolve = done; }));
        const first = read();
        const second = read({}, createContext('othermarket'));
        await clock.tickAsync(0);
        expect(count.callCount).to.equal(1);
        resolve({rows: [{ct: 10}]});
        expect(await first).to.equal(100);
        expect(await second).to.equal(100);
        await read();
        expect(count.callCount).to.equal(1);
    });

    it('keys on filter, value and sale state while retaining multiple entries', async () => {
        const {read, count, collectionName} = setup();
        await read();
        await read({state: '2'});
        await read({collection_name: `${collectionName}b`});
        await read({collection_name: undefined, schema_name: collectionName});
        await read();
        expect(count.callCount).to.equal(4);
    });

    it('treats positive and negative zero sale states as the same key', async () => {
        const {read, count} = setup();
        await read({state: '0'});
        await read({state: '-0'});
        expect(count.callCount).to.equal(1);
    });

    it('evicts rejected probes so a later request can retry', async () => {
        const {read, count} = setup();
        const error = new Error('count failed');
        count.rejects(error);
        const results = await Promise.allSettled([read(), read()]);
        expect(results).to.deep.equal([
            {status: 'rejected', reason: error},
            {status: 'rejected', reason: error},
        ]);
        expect(count.callCount).to.equal(1);
        count.resolves({rows: [{ct: 10}]});
        await read();
        expect(count.callCount).to.equal(2);
    });

    it('expires after 24 hours from insertion without extending on resolution or hits', async () => {
        const {read, count} = setup();
        let resolve: (value: {rows: {ct: number}[]}) => void;
        count.returns(new Promise(done => { resolve = done; }));
        const pending = read();
        await clock.tickAsync(500);
        resolve({rows: [{ct: 10}]});
        await pending;
        await clock.tickAsync(24 * 60 * 60 * 1000 - 501);
        await read();
        expect(count.callCount).to.equal(1);
        count.resolves({rows: [{ct: 20}]});
        await clock.tickAsync(1);
        await read();
        expect(count.callCount).to.equal(2);
    });
});
