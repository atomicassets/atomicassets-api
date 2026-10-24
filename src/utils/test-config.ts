/** Test commands may only initialize or connect to an explicit local test DB. */
export function getTestPostgresConfig() {
    const host = process.env.POSTGRES_TEST_HOST;
    const database = process.env.POSTGRES_TEST_DATABASE;

    if (!['localhost', '127.0.0.1', '::1'].includes(host)
        || !database || !/^(test[_-][a-z0-9_-]+|[a-z0-9_-]+[_-]test)$/.test(database)) {
        throw new Error('Set POSTGRES_TEST_HOST to a loopback address and POSTGRES_TEST_DATABASE to a dedicated test_* or *_test database. Operator connection configs are never used.');
    }

    return {
        host,
        port: Number(process.env.POSTGRES_TEST_PORT || 5432),
        user: process.env.POSTGRES_TEST_USER || 'root',
        password: process.env.POSTGRES_TEST_PASSWORD || 'testpassword',
        database,
    };
}
