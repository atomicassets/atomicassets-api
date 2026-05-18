import logger from '../utils/winston';
import * as fs from 'fs';
import { handlers } from './handlers/loader';
import { compareVersionString } from '../utils';
import PostgresConnection from '../connections/postgres';
import { IReaderConfig } from '../types/config';

export async function initBaseTables(database: PostgresConnection): Promise<void> {
    if (!(await database.tableExists('dbinfo'))) {
        logger.info('Could not find base tables. Create them now...');

        await database.query(fs.readFileSync('./definitions/tables/base_tables.sql', {
            encoding: 'utf8'
        }));

        logger.info('Base tables successfully created');
    } else {
        logger.info('Base tables already exist');
    }
}

export async function runMigrations(database: PostgresConnection): Promise<void> {
    logger.info('Checking for available upgrades...');

    // Load reader configs inside function to avoid requiring config at module load time
    // This allows initBaseTables to run without config (for schema-init hooks)
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const readerConfigs: IReaderConfig[] = require('/home/node/app/config/readers.config.json');

    const client = await database.begin();
    const versionQuery = await client.query('SELECT "value" FROM dbinfo WHERE name = \'version\'');
    const currentVersion = versionQuery.rows.length > 0 ? versionQuery.rows[0].value : '1.0.0';

    const availableHandlers = handlers;
    const availableContracts: string[] = readerConfigs
        .reduce((prev, curr) => [...prev, ...curr.contracts.map(row => row.handler)], [])
        .filter((row, pos, arr) => arr.indexOf(row) === pos);
    const availableVersions: string[] = fs.readdirSync('./definitions/migrations')
        .sort((a, b) => compareVersionString(a, b));

    // init contracts
    for (const handlerName of availableContracts) {
        const handler = availableHandlers.find(row => row.handlerName === handlerName);

        if (!handler) {
            logger.error('Contract handler configured which does not exist: ' + handlerName);

            process.exit(1);
        }

        if (await handler.setup(client)) {
            logger.info('Tables for handler ' + handlerName + ' created.');

            const pastVersions = availableVersions.filter(version => compareVersionString(version, currentVersion) <= 0);

            for (const version of pastVersions) {
                const filename = './definitions/migrations/' + version + '/' + handlerName + '.sql';

                if (fs.existsSync(filename)) {
                    await client.query(fs.readFileSync(filename, { encoding: 'utf8' }));
                }

                await handler.upgrade(client, version);
            }
        }
    }

    await client.query('COMMIT');

    const upgradeVersions = availableVersions.filter(version => compareVersionString(version, currentVersion) > 0);

    if (upgradeVersions.length > 0) {
        logger.info('Found ' + upgradeVersions.length + ' available upgrades. Starting to upgradeDB...');

        for (const version of upgradeVersions) {
            const versionDir = `${__dirname}/../../definitions/migrations/${version}/`;

            logger.info('Upgrade to ' + version + ' ...');

            await client.query('BEGIN');

            await client.query(fs.readFileSync(`${versionDir}database.sql`, {
                encoding: 'utf8'
            }));

            for (const handlerName of availableContracts) {
                const handler = availableHandlers.find(row => row.handlerName === handlerName);

                const handlerFilename = `${versionDir}${handlerName}.sql`;
                if (fs.existsSync(handlerFilename)) {
                    await client.query(fs.readFileSync(handlerFilename, { encoding: 'utf8' }));
                }

                await handler.upgrade(client, version);

                logger.info('Upgraded ' + handlerName + ' to ' + version);
            }

            logger.info('Successfully upgraded to ' + version);

            await client.query('COMMIT');

            // Execute deferred SQL outside transaction with extended timeout.
            // CREATE INDEX CONCURRENTLY can take minutes/hours on large tables
            // and cannot run inside a transaction, so we use a dedicated pool.
            const deferredPool = database.createPool({ statement_timeout: 3_600_000, max: 1 });
            try {
                for (const handlerName of availableContracts) {
                    const deferredFilename = `${versionDir}${handlerName}-deferred.sql`;
                    if (fs.existsSync(deferredFilename)) {
                        logger.info(`Running deferred SQL for ${handlerName} v${version}...`);
                        const sql = fs.readFileSync(deferredFilename, { encoding: 'utf8' });
                        // Strip SQL line comments before splitting on `;` so prose
                        // semicolons inside `-- ...` don't fragment statements.
                        // (1.6.1 shipped without this and crash-looped 6 fillers.)
                        const stripped = sql.replace(/--[^\n]*/g, '');
                        const statements = stripped.split(';').map(s => s.trim()).filter(s => s.length > 0);
                        for (const stmt of statements) {
                            logger.info(`Executing deferred: ${stmt.substring(0, 80)}...`);
                            await deferredPool.query(stmt);
                        }
                        logger.info(`Deferred SQL for ${handlerName} v${version} complete`);
                    }
                }
            } finally {
                await deferredPool.end();
            }
        }
    }

    client.release();
}

export async function upgradeDb(database: PostgresConnection): Promise<void> {
    await initBaseTables(database);
    await runMigrations(database);
}
