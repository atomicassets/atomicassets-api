import { runMigrations } from '../filler/upgrade-db';
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

    try {
        await runMigrations(connection.database);
        logger.info('Migration completed successfully');
    } catch (error) {
        logger.error('Failed to execute migration scripts', error);
        process.exit(1);
    }

    process.exit(0);
}

main().catch(err => {
    logger.error(err);
    process.exit(1);
});
