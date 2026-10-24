import { afterEach, describe, expect, it, vi } from 'vitest';
import { getTestPostgresConfig } from '../src/utils/test-config';

afterEach(() => vi.unstubAllEnvs());

describe('test database configuration', () => {
    it.each(['localhost', '127.0.0.1', '::1'])('accepts explicit loopback host %s', host => {
        vi.stubEnv('POSTGRES_TEST_HOST', host);
        vi.stubEnv('POSTGRES_TEST_DATABASE', 'test_atomicassets');
        expect(getTestPostgresConfig()).toMatchObject({ host, database: 'test_atomicassets' });
    });

    it.each([
        [undefined, 'test_atomicassets'],
        ['database.example.com', 'test_atomicassets'],
        ['127.0.0.1', undefined],
        ['127.0.0.1', 'atomicassets'],
        ['127.0.0.1', 'test_db"; DROP DATABASE atomicassets; --'],
    ])('refuses unsafe host/database pair %s / %s', (host, database) => {
        vi.stubEnv('POSTGRES_TEST_HOST', host);
        vi.stubEnv('POSTGRES_TEST_DATABASE', database);
        expect(getTestPostgresConfig).toThrow('dedicated');
    });

    it('ignores runtime production database overrides', () => {
        vi.stubEnv('POSTGRES_TEST_HOST', '127.0.0.1');
        vi.stubEnv('POSTGRES_TEST_DATABASE', 'atomicassets_test');
        vi.stubEnv('POSTGRES_TEST_PORT', '15432');
        vi.stubEnv('POSTGRES_HOST', 'production.example.com');
        vi.stubEnv('POSTGRES_DATABASE', 'production');
        expect(getTestPostgresConfig()).toMatchObject({
            host: '127.0.0.1', port: 15432, database: 'atomicassets_test',
        });
    });
});
