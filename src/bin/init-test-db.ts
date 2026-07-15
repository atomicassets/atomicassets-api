import { initBaseTables } from '../filler/upgrade-db';
import PostgresConnection from '../connections/postgres';
import logger from '../utils/winston';
import { IConnectionsConfig } from '../types/config';
import * as fs from 'fs';
import { handlers } from '../filler/handlers/loader';
import { compareVersionString } from '../utils';

function getPostgresConfig(): { host: string; port: number; user: string; password: string; database: string } {
    // CI mode: use POSTGRES_TEST_* env vars
    if (process.env.POSTGRES_TEST_HOST) {
        return {
            host: process.env.POSTGRES_TEST_HOST,
            port: parseInt(process.env.POSTGRES_TEST_PORT || '5432', 10),
            user: process.env.POSTGRES_TEST_USER || 'root',
            password: process.env.POSTGRES_TEST_PASSWORD || 'testpassword',
            database: process.env.POSTGRES_TEST_DATABASE || 'test_db',
        };
    }

    // Local dev mode: use connections.config.json
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const connectionConfig: IConnectionsConfig = require('../../config/connections.config.json');
    return connectionConfig.postgres;
}

async function main(): Promise<void> {
    const pg = getPostgresConfig();

    // In CI, POSTGRES_TEST_DATABASE is already the test database name.
    // In local dev, we append '-test' to the configured database name.
    const isCI = !!process.env.POSTGRES_TEST_HOST;
    const db = isCI ? pg.database : `${pg.database}-test`;

    if (!isCI) {
        const tmpConnection = new PostgresConnection(pg.host, pg.port, pg.user, pg.password, pg.database);
        logger.info(`Dropping test db with name ${db}`);
        await tmpConnection.query(`DROP DATABASE IF EXISTS "${db}"`);
        logger.info(`Creating test db with name ${db}`);
        await tmpConnection.query(`CREATE DATABASE "${db}"`);
    }

    const connection = new PostgresConnection(pg.host, pg.port, pg.user, pg.password, db);

    // Initialize base tables
    await initBaseTables(connection);

    // Initialize handler tables without requiring readers.config.json.
    // These are the handlers whose tables are needed by integration tests.
    // atomicpacksx + atomicdropsx ship in 1.5.0; their *.integration.test.ts
    // files would fail in CI without the schema. Keep this list aligned with
    // any new handler that introduces *.integration.test.ts coverage.
    const testHandlers = ['atomicassets', 'delphioracle', 'atomicmarket', 'atomicpacksx', 'atomicdropsx'];

    const setupClient = await connection.begin();
    for (const handlerName of testHandlers) {
        const handler = handlers.find(row => row.handlerName === handlerName);
        if (handler) {
            await handler.setup(setupClient);
            logger.info(`Tables for handler ${handlerName} created.`);
        }
    }
    await setupClient.query('COMMIT');
    setupClient.release();

    // Run migration SQL files for database and each handler
    const availableVersions: string[] = fs.readdirSync('./definitions/migrations')
        .sort((a, b) => compareVersionString(a, b));

    for (const version of availableVersions) {
        const versionDir = `./definitions/migrations/${version}/`;
        const migrClient = await connection.begin();

        const dbFile = `${versionDir}database.sql`;
        if (fs.existsSync(dbFile)) {
            await migrClient.query(fs.readFileSync(dbFile, { encoding: 'utf8' }));
        }

        for (const handlerName of testHandlers) {
            const handlerFile = `${versionDir}${handlerName}.sql`;
            if (fs.existsSync(handlerFile)) {
                await migrClient.query(fs.readFileSync(handlerFile, { encoding: 'utf8' }));
            }

            const handler = handlers.find(row => row.handlerName === handlerName);
            if (handler) {
                await handler.upgrade(migrClient, version);
            }
        }

        await migrClient.query('COMMIT');
        migrClient.release();

        // Deferred migrations run out-of-band in production because
        // CONCURRENTLY cannot run inside a transaction, but the indexes they
        // create are part of the schema the code relies on (e.g. the unique
        // mints index that ON CONFLICT targets). Apply them here autocommit,
        // with CONCURRENTLY stripped - the test tables are empty.
        for (const handlerName of ['database', ...testHandlers]) {
            const deferredFile = handlerName === 'database'
                ? `${versionDir}database-deferred.sql`
                : `${versionDir}${handlerName}-deferred.sql`;
            if (fs.existsSync(deferredFile)) {
                const sql = fs.readFileSync(deferredFile, { encoding: 'utf8' })
                    .replace(/\bCONCURRENTLY\b/gi, '');
                await connection.query(sql);
                logger.info(`Applied deferred migration ${deferredFile}`);
            }
        }
    }

    logger.info('Test database initialized successfully');
    process.exit(0);
}

main().catch(err => {
    logger.error(err);
    process.exit(1);
});
