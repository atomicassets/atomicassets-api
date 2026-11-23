import 'mocha';
import { expect } from 'chai';

import { buildAssetQueryCondition } from './assets';
import QueryBuilder from '../../../builder';

describe('buildAssetQueryCondition - template mint bounds', () => {
    const tooLarge = String(Number.MAX_SAFE_INTEGER) + '0';

    for (const key of ['template_mint', 'min_template_mint', 'max_template_mint']) {
        it(`${key} above the safe integer range is refused as a 400`, async () => {
            let error: any = null;

            try {
                await buildAssetQueryCondition({[key]: tooLarge}, new QueryBuilder('SELECT 1'), {assetTable: 'asset'});
            } catch (e) {
                error = e;
            }

            expect(error).to.not.equal(null);
            expect(error.code).to.equal(400);
            expect(error.message).to.contain(`Invalid value for parameter ${key}`);
        });
    }

    it('template_mint at the safe integer limit is accepted', async () => {
        await buildAssetQueryCondition(
            {template_mint: String(Number.MAX_SAFE_INTEGER)}, new QueryBuilder('SELECT 1'), {assetTable: 'asset'}
        );
    });
});
