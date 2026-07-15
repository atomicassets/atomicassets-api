import ConnectionManager from '../connections/manager';
import logger from '../utils/winston';
import { IConnectionsConfig, IReaderConfig } from '../types/config';
import { configFile } from '../utils/config-path';
import { assertReaderStopped, reconcileAtomicAssetsContract } from '../filler/handlers/atomicassets/reconcile';

let connectionConfig: IConnectionsConfig = { postgres: {}, redis: {}, chain: {} } as IConnectionsConfig;

try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    connectionConfig = require(configFile('connections.config.json'));
} catch {
    logger.warn('No connections.config.json found. Falling back to environment variables');
}

let readerConfigs: IReaderConfig[] = [];

try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    readerConfigs = require(configFile('readers.config.json'));
} catch (error) {
    logger.error('No readers.config.json found - reconcile needs it to find the configured atomicassets contracts', error);
    process.exit(1);
}

async function main(): Promise<void> {
    const connection = new ConnectionManager(connectionConfig);
    await connection.connect();

    const atomicassetsReaders = readerConfigs.flatMap(reader =>
        reader.contracts
            .filter(contract => contract.handler === 'atomicassets')
            .map(contract => ({ readerName: reader.name, atomicassetsAccount: contract.args.atomicassets_account as string }))
    );

    if (atomicassetsReaders.length === 0) {
        logger.error('No atomicassets contracts found in readers.config.json - nothing to reconcile');
        process.exit(1);
    }

    let exitCode = 0;

    for (const { readerName, atomicassetsAccount } of atomicassetsReaders) {
        try {
            const readerQuery = await connection.database.query(
                'SELECT live, updated FROM contract_readers WHERE name = $1',
                [readerName]
            );

            assertReaderStopped(readerQuery.rows[0], readerName);

            logger.info('AtomicAssets reconcile: starting for contract ' + atomicassetsAccount + ' (reader "' + readerName + '")');

            const client = await connection.database.pool.connect();

            try {
                await reconcileAtomicAssetsContract(client, connection.chain.rpc, atomicassetsAccount);
            } finally {
                client.release();
            }
        } catch (error) {
            logger.error('AtomicAssets reconcile failed for contract ' + atomicassetsAccount + ' (reader "' + readerName + '")', error);
            exitCode = 1;
        }
    }

    process.exit(exitCode);
}

main().catch(err => {
    logger.error(err);
    process.exit(1);
});
