import { initBaseTables } from '../filler/upgrade-db';
import ConnectionManager from '../connections/manager';
import logger from '../utils/winston';
import { IConnectionsConfig } from '../types/config';

let connectionConfig: IConnectionsConfig = { postgres: {}, redis: {}, chain: {} } as IConnectionsConfig;

try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    connectionConfig = require('/home/application/app/config/connections.config.json');
} catch {
    logger.warn('No connections.config.json found. Falling back to environment variables');
}

async function main(): Promise<void> {
    const connection = new ConnectionManager(connectionConfig);
    await connection.connect();

    try {
        await initBaseTables(connection.database);
        logger.info('Schema initialization completed successfully');
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
