import 'mocha';
import {expect} from 'chai';
import * as sinon from 'sinon';
import {initListValidator} from './lists';
import {filterQueryArgs} from './validation';
import type {DB} from '../server';

describe('list item cache', () => {
    let clock: sinon.SinonFakeTimers;
    let sequence = 0;

    beforeEach(() => {
        clock = sinon.useFakeTimers();
    });

    afterEach(() => {
        clock.restore();
    });

    function setup(fetchOne: sinon.SinonStub) {
        initListValidator({fetchOne} as unknown as DB);
        const name = `cache-list-${++sequence}`;
        const read = (list = name) => filterQueryArgs({items: `$list:${list}`}, {items: {type: 'list[string]'}});
        return {name, read};
    }

    it('deduplicates pending queries by list name, ignoring the database argument', async () => {
        let resolve: (value: {items: string[]}) => void;
        const fetchOne = sinon.stub().returns(new Promise(done => { resolve = done; }));
        const {read} = setup(fetchOne);
        const first = read();
        const otherDb = sinon.stub().resolves({items: ['other']});
        initListValidator({fetchOne: otherDb} as unknown as DB);
        const second = read();
        await clock.tickAsync(0);
        expect(fetchOne.callCount).to.equal(1);
        expect(otherDb.called).to.be.false;
        resolve({items: ['alice']});
        expect(await first).to.deep.equal({items: ['alice']});
        expect(await second).to.deep.equal({items: ['alice']});
        expect(await read()).to.deep.equal({items: ['alice']});
    });

    it('retains multiple names and maps an empty aggregation to an empty list', async () => {
        const fetchOne = sinon.stub().resolves({items: null});
        const {name, read} = setup(fetchOne);
        expect(await read()).to.deep.equal({items: []});
        await read(`${name}-other`);
        await read();
        expect(fetchOne.callCount).to.equal(2);
        expect(fetchOne.firstCall.args[1]).to.deep.equal([name]);
    });

    it('retries after a shared async rejection', async () => {
        const fetchOne = sinon.stub().rejects(new Error('database unavailable'));
        const {read} = setup(fetchOne);
        const results = await Promise.allSettled([read(), read()]);
        expect(results.map(result => result.status)).to.deep.equal(['rejected', 'rejected']);
        expect(fetchOne.callCount).to.equal(1);
        fetchOne.resolves({items: ['recovered']});
        expect(await read()).to.deep.equal({items: ['recovered']});
        expect(fetchOne.callCount).to.equal(2);
    });

    it('expires five minutes after insertion, without extending on resolution or hits', async () => {
        let resolve: (value: {items: string[]}) => void;
        const fetchOne = sinon.stub().returns(new Promise(done => { resolve = done; }));
        const {read} = setup(fetchOne);
        const pending = read();
        await clock.tickAsync(60_000);
        resolve({items: ['old']});
        await pending;
        await clock.tickAsync(239_999);
        expect(await read()).to.deep.equal({items: ['old']});
        expect(fetchOne.callCount).to.equal(1);
        fetchOne.resolves({items: ['new']});
        await clock.tickAsync(1);
        expect(await read()).to.deep.equal({items: ['new']});
        expect(fetchOne.callCount).to.equal(2);
    });
});
