import 'mocha';
import {expect} from 'chai';
import {AtomicAssetsNamespace} from './index';
import {AtomicMarketNamespace} from '../atomicmarket';

describe('fast asset count namespace configuration', () => {
    for (const Namespace of [AtomicAssetsNamespace, AtomicMarketNamespace]) {
        function namespace(value: unknown) {
            return Object.assign(Object.create(Namespace.prototype), {
                args: {
                    atomicassets_account: 'aatest', atomicmarket_account: 'amtest', delphioracle_account: 'dotest',
                    enable_fast_asset_counts: value,
                },
                connection: {database: {query: async () => ({rowCount: 0, rows: []})}},
            }) as AtomicAssetsNamespace | AtomicMarketNamespace;
        }

        for (const value of [undefined, true, false]) {
            it(`${Namespace.namespaceName} accepts ${String(value)}`, async () => {
                const core = namespace(value);
                await core.init();
                expect(core.args.enable_fast_asset_counts).to.equal(value);
            });
        }

        for (const value of ['false', 0, null]) {
            it(`${Namespace.namespaceName} rejects ${JSON.stringify(value)}`, async () => {
                await expect(namespace(value).init()).to.be.rejectedWith(
                    `Invalid argument in ${Namespace.namespaceName} api namespace: enable_fast_asset_counts must be a boolean`
                );
            });
        }
    }
});
