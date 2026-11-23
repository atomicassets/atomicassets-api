import 'mocha';
import { expect } from 'chai';

import { buildTemplateMintFilter } from './utils';
import QueryBuilder from '../../builder';

describe('buildTemplateMintFilter - mint bounds', () => {
    const tooLarge = String(Number.MAX_SAFE_INTEGER) + '0';

    for (const key of ['min_template_mint', 'max_template_mint']) {
        it(`${key} above the safe integer range is refused as a 400`, async () => {
            let error: any = null;

            try {
                await buildTemplateMintFilter({[key]: tooLarge}, new QueryBuilder('SELECT 1'));
            } catch (e) {
                error = e;
            }

            expect(error).to.not.equal(null);
            expect(error.code).to.equal(400);
            expect(error.message).to.contain(`Invalid value for parameter ${key}`);
        });
    }

    it('min_template_mint at the safe integer limit is accepted', async () => {
        await buildTemplateMintFilter({min_template_mint: String(Number.MAX_SAFE_INTEGER)}, new QueryBuilder('SELECT 1'));
    });
});
