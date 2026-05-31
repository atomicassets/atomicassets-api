import 'mocha';
import { expect } from 'chai';

import { positiveIntEnv } from './env';

describe('positiveIntEnv', () => {
    const KEY = 'POSITIVE_INT_ENV_TEST';
    afterEach(() => { delete process.env[KEY]; });

    it('falls back to the default when unset', () => {
        expect(positiveIntEnv(KEY, 42)).to.equal(42);
    });

    it('parses a valid positive integer', () => {
        process.env[KEY] = '100';
        expect(positiveIntEnv(KEY, 42)).to.equal(100);
    });

    for (const bad of ['0', '-1', '-500', 'abc', '']) {
        it(`falls back to the default for non-positive/invalid value "${bad}"`, () => {
            process.env[KEY] = bad;
            expect(positiveIntEnv(KEY, 42)).to.equal(42);
        });
    }
});
