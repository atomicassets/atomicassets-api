import * as os from 'os';

import * as cluster from 'cluster';
import express from 'express';

import Filler from '../filler/filler';
import ConnectionManager from '../connections/manager';
import logger from '../utils/winston';
import { IConnectionsConfig, IReaderConfig } from '../types/config';
import { upgradeDb } from '../filler/upgrade-db';
import { MetricsCollectorHandler } from '../metrics/handler';
import { Registry } from 'prom-client';
import { setAutoVacSettings } from '../filler/set-autovac-settings';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const readerConfigs: IReaderConfig[] = require('/home/node/app/config/readers.config.json');

let connectionConfig: IConnectionsConfig = { postgres: {}, redis: {}, chain: {} } as IConnectionsConfig;

try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    connectionConfig = require('/home/node/app/config/connections.config.json');
} catch {
    logger.warn('No connections.config.json found. Falling back to environment variables');
}

if (!readerConfigs || readerConfigs.length === 0) {
    logger.error('No readers defined');

    process.exit(-1);
}

// @ts-ignore
if (cluster.isPrimary || cluster.isMaster) {
    logger.info('Starting workers...');

    const connection = new ConnectionManager(connectionConfig);

    (async (): Promise<void> => {
        await connection.connect();

        if (!(await connection.chain.checkChainId())) {
            logger.error('Chain Id in config mismatches node chain id');

            process.exit(1);
        }

        try {
            await upgradeDb(connection.database);
        } catch (error) {
            logger.error('Failed to execute migration scripts', error);

            process.exit(1);
        }

        setAutoVacSettings(connection).then(
            () => logger.info('Finished setting autovacuum settings'),
            error => logger.error('Failed setting autovacuum settings', error)
        );

        for (let i = 0; i < readerConfigs.length; i++) {
            // @ts-ignore
            const worker = cluster.fork({ config_index: i });

            worker.on('message', (data: any) => {
                if (data.msg === 'failure') {
                    process.exit(-1);
                }
            });
        }
    })();

    const app = express();

    app.get('/healthc', async (req, res) => {
        if (await connection.alive()) {
            res.status(200).send('success');
        } else {
            res.status(500).send('error');
        }
    });

    app.get('/status', async (req, res) => {
        try {
            const info = await connection.chain.rpc.get_info();
            const result = await connection.database.query<{ name: string; block_num: string; block_time: string }>(
                'SELECT name, block_num, block_time FROM contract_readers'
            );

            const fillers = result.rows.map((reader) => {
                const currentBlock = parseInt(reader.block_num);
                const headBlock = info.head_block_num;
                const blocksBehind = headBlock - currentBlock;

                return {
                    identifier: reader.name,
                    blockchain: connectionConfig.chain.name,
                    type: 'block' as const,
                    currentBlock,
                    headBlock,
                    blocksBehind,
                    syncPercentage: headBlock > 0 ? Math.min(100, (currentBlock / headBlock) * 100) : null,
                    isSynced: blocksBehind <= 10,
                    lastUpdated: parseInt(reader.block_time),
                };
            });

            res.json({
                service: 'eosio-contract-api-filler',
                timestamp: Date.now(),
                fillers,
            });
        } catch (e) {
            logger.error('Error collecting status', e);
            res.status(500).json({ error: 'Failed to collect status' });
        }
    });

    app.all('/metrics', async (_req, res) => {
        const metricsHandler = new MetricsCollectorHandler(
            connection,
            'filler',
            os.hostname(),
            { psql_pool: false },
        );
        res.send(await metricsHandler.getMetrics(new Registry()));
    });

    const server = app.listen(readerConfigs[0].server_port || 9001, readerConfigs[0].server_addr || '0.0.0.0');

    process.on('SIGTERM', () => {
        logger.info('Primary received SIGTERM — shutting down workers');

        server.close();

        // @ts-ignore
        for (const id in cluster.workers) {
            // @ts-ignore
            cluster.workers[id]?.process.kill('SIGTERM');
        }
    });
} else {
    logger.info('Worker ' + process.pid + ' started');

    const index = parseInt(process.env.config_index, 10);
    let filler: Filler | null = null;

    process.on('SIGTERM', async () => {
        logger.info(`Worker ${process.pid} received SIGTERM — stopping filler`);

        if (filler) {
            await filler.stopFiller();
        }

        process.exit(0);
    });

    // delay startup for each reader to avoid startup transaction conflicts
    setTimeout(async () => {
        const connection = new ConnectionManager(connectionConfig);
        filler = new Filler(readerConfigs[index], connection);

        await filler.startFiller(5);
    }, index * 1000);
}
