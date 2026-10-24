import { initBaseTables } from '../filler/upgrade-db';
import PostgresConnection from '../connections/postgres';
import logger from '../utils/winston';
import { getTestPostgresConfig } from '../utils/test-config';
import * as fs from 'fs';
import { handlers } from '../filler/handlers/loader';
import { compareVersionString } from '../utils';

async function main(): Promise<void> {
    const pg = getTestPostgresConfig();
    const db = pg.database;

    const connection = new PostgresConnection(pg.host, pg.port, pg.user, pg.password, db);

    // Initialize base tables
    await initBaseTables(connection);

    // Initialize handler tables without requiring readers.config.json.
    // These are the handlers whose tables are needed by integration tests.
    // atomicpacksx + atomicdropsx ship in 1.5.0; their *.integration.test.ts
    // files would fail in CI without the schema. Keep this list aligned with
    // any new handler that introduces *.integration.test.ts coverage.
    const testHandlers = ['atomicassets', 'delphioracle', 'atomicmarket', 'atomicpacksx', 'atomicdropsx', 'simpleassets'];

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
