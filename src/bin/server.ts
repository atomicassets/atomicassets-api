import ConnectionManager from '../connections/manager';
import logger from '../utils/winston';
import { IConnectionsConfig, IServerConfig } from '../types/config';
import Api from '../api/api';
import {MetricsServer} from '../metrics/server';
import {HttpMetrics} from '../api/middlewares/http-metrics';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const serverConfig: IServerConfig = require('/home/node/app/config/server.config.json');

let connectionConfig: IConnectionsConfig = {postgres: {}, redis: {}, chain: {}} as IConnectionsConfig;

try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    connectionConfig = require('/home/node/app/config/connections.config.json');
} catch {
    logger.warn('No connections.config.json found. Falling back to environment variables');
}

logger.info('Starting API Server...');

process.on('unhandledRejection', error => {
    logger.error('Unhandled Rejection', error);
});

process.on('uncaughtException', error => {
    logger.error('Uncaught Exception', error);
});

const connection = new ConnectionManager(connectionConfig);

(async (): Promise<void> => {
    await connection.connect();

    connection.chain.checkChainId().then(result => {
        if (!result) {
            logger.error('Chain Id in config mismatches node chain id. Stopping API...');

            process.exit(1);
        }
    }).catch(error => {
        logger.error('Failed to query chain id on startup. Ignoring it but please check the config for the correct endpoint', error);
    });

    if (!(await connection.database.tableExists('dbinfo'))) {
        logger.error('Tables not initialized yet. Stopping API...');

        process.exit(1);
    }

    try {
        // Shared HTTP metrics instance: middleware records into its Registry
        // on the main API port; MetricsServer exposes that Registry alongside
        // the existing collector gauges on the separate metrics_port. The
        // ServiceMonitor in Kubernetes scrapes metrics_port, so HTTP latency
        // and the collector's pool/connection gauges are served from one
        // endpoint, matching the prometheus-adapter rule that feeds the HPA.
        const httpMetrics = new HttpMetrics({
            serviceName: 'eosio-contract-api-server',
            // Skip infra probes so they don't pollute the p95 used for
            // HPA scaling. /metrics itself is on a different Express app
            // (metrics_port), so it doesn't need to be skipped here.
            skipPaths: [
                '/health',
                '/healthc',
                '/alive',
                '/eosio-contract-api/health',
                '/eosio-contract-api/alive',
            ],
        });
        const server = new Api(serverConfig, connection, httpMetrics);
        if (serverConfig.metrics_port) {
            new MetricsServer(serverConfig.metrics_port, connection, 'api', {}, httpMetrics).serve();
        }
        await server.listen();
    } catch (e) {
        logger.error('Failed to start server', e);
    }
})();
