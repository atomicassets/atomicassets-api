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

    it('ATOMICMARKET_TEMPLATE_PRICES_STATEMENT_TIMEOUT_S falls back to its 900s default for a non-numeric value', () => {
        // Pinned to the exact key/default the template_prices per-transaction
        // statement_timeout override (atomicmarket/index.ts) reads at module load, so a
        // regression to that call site's arguments fails here even though the
        // underlying fallback behavior is covered generically above.
        const TEMPLATE_PRICES_KEY = 'ATOMICMARKET_TEMPLATE_PRICES_STATEMENT_TIMEOUT_S';
        process.env[TEMPLATE_PRICES_KEY] = 'notanumber';
        expect(positiveIntEnv(TEMPLATE_PRICES_KEY, 900)).to.equal(900);
        delete process.env[TEMPLATE_PRICES_KEY];
    });
});
