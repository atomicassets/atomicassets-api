import { initBaseTables } from '../filler/upgrade-db';
import PostgresConnection from '../connections/postgres';
import logger from '../utils/winston';
import { IConnectionsConfig } from '../types/config';
import { configFile } from '../utils/config-path';

let connectionConfig: IConnectionsConfig | null = null;

try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    connectionConfig = require(configFile('connections.config.json'));
} catch {
    logger.warn('No connections.config.json found. Falling back to environment variables');
}

async function main(): Promise<void> {
    // For schema-init, we only need database connection (not chain or redis)
    // Use PG* env vars (standard PostgreSQL) with fallback to config file
    const database = new PostgresConnection(
        process.env.PGHOST || connectionConfig?.postgres?.host || 'localhost',
        parseInt(process.env.PGPORT || String(connectionConfig?.postgres?.port) || '5432', 10),
        process.env.PGUSER || connectionConfig?.postgres?.user || 'postgres',
        process.env.PGPASSWORD || connectionConfig?.postgres?.password || '',
        process.env.PGDATABASE || connectionConfig?.postgres?.database || 'postgres'
    );
    await database.connect();

    // Use PostgreSQL advisory lock to prevent concurrent schema initialization
    // Lock ID: 1234567890 (arbitrary unique number for schema init)
    const SCHEMA_INIT_LOCK_ID = 1234567890;

    try {
        logger.info('Acquiring advisory lock for schema initialization...');
        await database.query('SELECT pg_advisory_lock($1)', [SCHEMA_INIT_LOCK_ID]);
        logger.info('Advisory lock acquired');

        try {
            await initBaseTables(database);
            logger.info('Schema initialization completed successfully');
        } finally {
            await database.query('SELECT pg_advisory_unlock($1)', [SCHEMA_INIT_LOCK_ID]);
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
