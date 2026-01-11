import { initBaseTables } from '../filler/upgrade-db';
import ConnectionManager from '../connections/manager';
import logger from '../utils/winston';
import { IConnectionsConfig } from '../types/config';

let connectionConfig: IConnectionsConfig = { postgres: {}, redis: {}, chain: {} } as IConnectionsConfig;

try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    connectionConfig = require('/home/node/app/config/connections.config.json');
} catch {
    logger.warn('No connections.config.json found. Falling back to environment variables');
}

async function main(): Promise<void> {
    const connection = new ConnectionManager(connectionConfig);
    await connection.connect();

    // Use PostgreSQL advisory lock to prevent concurrent schema initialization
    // Lock ID: 1234567890 (arbitrary unique number for schema init)
    const SCHEMA_INIT_LOCK_ID = 1234567890;

    try {
        logger.info('Acquiring advisory lock for schema initialization...');
        await connection.database.query('SELECT pg_advisory_lock($1)', [SCHEMA_INIT_LOCK_ID]);
        logger.info('Advisory lock acquired');

        try {
            await initBaseTables(connection.database);
            logger.info('Schema initialization completed successfully');
        } finally {
            await connection.database.query('SELECT pg_advisory_unlock($1)', [SCHEMA_INIT_LOCK_ID]);
            logger.info('Advisory lock released');
        }
    } catch (error) {
        logger.error('Failed to execute schema initialization', error);
        process.exit(1);
    }

    process.exit(0);
}

main().catch(err => {
    logger.error(err);
    process.exit(1);
});
