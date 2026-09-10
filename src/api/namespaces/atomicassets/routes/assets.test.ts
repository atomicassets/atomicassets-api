import 'mocha';
import {expect} from 'chai';
import sinon from 'sinon';
import {HTTPServer} from '../../../server';
import {AtomicAssetsContext, AtomicAssetsNamespace} from '../index';
import {AssetApi} from './assets';

function setup(counter = '3', enabled = true, assets = [{asset_id: '42'}]) {
    const query = sinon.stub().callsFake(async (sql: string) => {
        if (/SELECT COUNT\(\*\)|COALESCE\(SUM\(/.test(sql)) {
            return {rows: [{counter}], rowCount: 1};
        }
        return {rows: assets, rowCount: assets.length};
    });
    const db = {query};
    const args = {atomicassets_account: 'aatest', enable_fast_asset_counts: enabled};
    const ctx = {db, coreArgs: args, pathParams: {}} as unknown as AtomicAssetsContext;
    const formatter = sinon.spy((row: {asset_id: string}) => ({...row, formatted: true}));
    const hook = sinon.stub().callsFake(async (_db, _contract, rows) => rows);
    const api = new AssetApi(
        {args} as AtomicAssetsNamespace, db as unknown as HTTPServer,
        'Asset', 'atomicassets_assets_master', formatter, hook
    );
    return {api, ctx, query, formatter, hook};
}

describe('AtomicAssets listing count responses', () => {
    for (const {name, enabled, params, sql} of [
        {name: 'aggregate', enabled: true, params: {}, sql: /FROM atomicassets_asset_counts ac/},
        {name: 'disabled aggregate', enabled: false, params: {}, sql: /SELECT COUNT\(\*\)/},
        {name: 'asset boundary filter', enabled: true, params: {lower_bound: '42'}, sql: /SELECT COUNT\(\*\)/},
    ]) {
        for (const counter of ['0', '3', '9007199254740993']) {
            it(`returns ${name} count ${counter} without filling assets`, async () => {
                const {api, ctx, query, formatter, hook} = setup(counter, enabled);

                expect(await api.getAssetsAction({...params, count: 'true', page: '2', limit: '1'}, ctx))
                    .to.equal(counter);

                expect(query.callCount).to.equal(1);
                expect(query.firstCall.args[0]).to.match(sql);
                expect(formatter.called).to.equal(false);
                expect(hook.called).to.equal(false);
            });
        }
    }

    for (const params of [{}, {count: 'false'}]) {
        it(`still fills assets with ${JSON.stringify(params)}`, async () => {
            const {api, ctx, query, formatter, hook} = setup();

            expect(await api.getAssetsAction(params, ctx)).to.deep.equal([{asset_id: '42', formatted: true}]);

            expect(query.callCount).to.equal(2);
            expect(query.secondCall.args[0]).to.contain('FROM atomicassets_assets_master');
            expect(query.secondCall.args[1]).to.deep.equal(['aatest', ['42']]);
            expect(formatter.calledOnce).to.equal(true);
            expect(hook.calledOnce).to.equal(true);
        });
    }

    it('preserves empty listings', async () => {
        const {api, ctx, query, formatter, hook} = setup('0', true, []);

        expect(await api.getAssetsAction({}, ctx)).to.deep.equal([]);
        expect(query.calledOnce).to.equal(true);
        expect(formatter.called).to.equal(false);
        expect(hook.called).to.equal(false);
    });
});
