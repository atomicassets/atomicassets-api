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
import { retryTransient } from '../utils/retry';
import { configFile } from '../utils/config-path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const readerConfigs: IReaderConfig[] = require(configFile('readers.config.json'));

// In-memory block history for computing sync rate per reader.
// Each /status call appends a {block, time} snapshot; entries older than
// RATE_WINDOW_MS are pruned so we derive blocksPerSecond from a sliding window.
const blockHistory: Map<string, Array<{ block: number; time: number }>> = new Map();
const RATE_WINDOW_MS = 60_000;

let connectionConfig: IConnectionsConfig = { postgres: {}, redis: {}, chain: {} } as IConnectionsConfig;

try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    connectionConfig = require(configFile('connections.config.json'));
} catch {
    logger.warn('No connections.config.json found. Falling back to environment variables');
}

if (!readerConfigs || readerConfigs.length === 0) {
    logger.error('No readers defined');

    process.exit(-1);
}

// Log and exit rather than stay up: swallowing these here left a filler
// process alive-but-dead after a startup rejection (e.g. a statement-timeout
// during AtomicAssetsHandler.init on a cold cache) - the reader never
// started but Kubernetes had no crashed process to restart. Node's default
// (crash) is what gets the pod restarted; matching it here is the fix.
process.on('unhandledRejection', error => {
    logger.error('Unhandled Rejection', error);

    process.exit(1);
});

process.on('uncaughtException', error => {
    logger.error('Uncaught Exception', error);

    process.exit(1);
});

// @ts-ignore
if (cluster.isPrimary || cluster.isMaster) {
    logger.info('Starting workers...');

    const connection = new ConnectionManager(connectionConfig);

    // Set before killing workers on SIGTERM so the cluster 'exit' listener
    // below can tell a requested shutdown (workers exit with signal SIGTERM)
    // from an unexpected worker death and not escalate the former.
    let isShuttingDown = false;

    // Every forked worker owns one reader config; losing any of them
    // silently degrades the filler to fewer active readers. The
    // worker.on('message', 'failure') path below only covers a worker that
    // reports its own fatal error - a worker killed by its own
    // unhandledRejection/uncaughtException handler (above) exits without
    // sending that message, so the primary would otherwise keep running
    // with a dead reader and a still-green /healthc. This is the safety net
    // beneath the 'failure' path: any unexpected worker exit takes the
    // primary down too, so Kubernetes restarts the pod.
    cluster.on('exit', (worker, code, signal) => {
        if (isShuttingDown) {
            return;
        }

        logger.error(`Worker ${worker.process.pid} exited unexpectedly (code=${code}, signal=${signal})`);

        process.exit(1);
    });

    (async (): Promise<void> => {
        // The node (and DB/redis) can be transiently unreachable at boot — the
        // SHIP/RPC pod may be mid-restart even after the wait-for-ship init gate.
        // Wait it out with bounded backoff (~5 min) instead of letting an
        // ECONNREFUSED crash-loop the whole filler.
        const startupRetry = { retries: 30, maxDelayMs: 10_000 } as const;

        await retryTransient(() => connection.connect(), { label: 'connect()', ...startupRetry });

        let chainIdMatches: boolean;
        try {
            chainIdMatches = await retryTransient(
                () => connection.chain.checkChainId(),
                { label: 'checkChainId', ...startupRetry }
            );
        } catch (error) {
            logger.error('Unable to reach chain node to verify chain id after retries', error);

            process.exit(1);
        }

        if (!chainIdMatches) {
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
    })().catch(error => {
        logger.error('Fatal error during filler startup', error);

        process.exit(1);
    });

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

                // Track block history for rate computation
                const now = Date.now();
                const history = blockHistory.get(reader.name) ?? [];
                history.push({ block: currentBlock, time: now });
                const cutoff = now - RATE_WINDOW_MS;
                const trimmed = history.filter(h => h.time >= cutoff);
                blockHistory.set(reader.name, trimmed);

                let blocksPerSecond: number | undefined;
                if (trimmed.length >= 2) {
                    const oldest = trimmed[0];
                    const elapsed = (now - oldest.time) / 1000;
                    if (elapsed > 0) {
                        blocksPerSecond = Math.max(0, (currentBlock - oldest.block) / elapsed);
                    }
                }

                let estimatedSecondsRemaining: number | undefined;
                if (blocksPerSecond && blocksPerSecond > 0 && blocksBehind > 0) {
                    estimatedSecondsRemaining = blocksBehind / blocksPerSecond;
                }

                return {
                    identifier: reader.name,
                    blockchain: connectionConfig.chain.name,
                    type: 'block' as const,
                    currentBlock,
                    headBlock,
                    blocksBehind,
                    syncPercentage: headBlock > 0 ? Math.min(100, (currentBlock / headBlock) * 100) : null,
                    blocksPerSecond,
                    estimatedSecondsRemaining,
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

        isShuttingDown = true;

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
