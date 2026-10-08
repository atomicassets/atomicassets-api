import 'mocha';
import { expect } from 'chai';

import { getSalesV2Action } from './sales2';
import { AtomicMarketContext } from '../index';

describe('getSalesV2Action - integer bounds', () => {
    const tooLarge = String(Number.MAX_SAFE_INTEGER) + '0';
    const ctx = {
        pathParams: {},
        db: {
            query: async (): Promise<any> => ({rows: [], rowCount: 0}),
            fetchOne: async (): Promise<any> => null,
        },
        coreArgs: {atomicmarket_account: 'atomicmarket', atomicassets_account: 'atomicassets', limits: {}},
    } as unknown as AtomicMarketContext;

    for (const key of ['min_template_mint', 'max_template_mint', 'min_assets', 'max_assets']) {
        it(`${key} above the safe integer range is refused as a 400`, async () => {
            let error: any = null;

            try {
                await getSalesV2Action({[key]: tooLarge}, ctx);
            } catch (e) {
                error = e;
            }

            expect(error).to.not.equal(null);
            expect(error.code).to.equal(400);
            expect(error.message).to.contain(`Invalid value for parameter ${key}`);
        });
    }
});
